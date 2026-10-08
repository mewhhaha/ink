import {
  decodeInput,
  encodeInput,
  type EventModel,
  idleInput,
} from "@ink/schema";
import { NetworkError, Rollback } from "./rollback.ts";
import type { PlayDriver, Session } from "./session.ts";

export type NetworkMode = "rollback" | "lockstep";
export interface JoinGame {
  kind: "join";
  room: string;
  identity: string;
  state: number[];
  names: [number, string][];
  tickRate: number;
  mode: NetworkMode;
  /** Simulated one-way input delay at the relay, for testing. */
  delayMs: number;
}
export type NetworkSend = JoinGame | { kind: "ready" | "leave" } | {
  kind: "input";
  lanes: number[];
} | { kind: "hash"; tick: number; hash: string };
export type NetworkReceive =
  | { kind: "waiting"; room: string }
  | {
    kind: "prepare";
    peer: number;
    state: number[];
    names: [number, string][];
    tickRate: number;
    mode: NetworkMode;
    delayMs: number;
  }
  | { kind: "go" }
  | { kind: "input"; peer: number; lanes: number[] }
  | { kind: "hash"; peer: number; tick: number; hash: string }
  | { kind: "closed"; reason: string };

export interface NetworkChannel {
  send(message: NetworkSend): void;
  close(): void;
}

export interface NetworkStatus {
  phase: "waiting" | "playing" | "closed";
  peer?: number;
  tick: number;
  confirmed: number;
  predicted: number;
  rollbacks: number;
  replayedTicks: number;
  delayMs: number;
  mode: NetworkMode;
  reason?: string;
}

/** Drives the real Session and its timeline; transport only exchanges inputs. */
export class MultiplayerPlay implements PlayDriver {
  readonly label = "multiplayer";
  rollback?: Rollback;
  peer = -1;
  #running = false;
  #closed = false;
  #accumulator = 0;
  #events = new Map<number, EventModel[]>();
  #status: NetworkStatus;
  #timer?: ReturnType<typeof setInterval>;

  constructor(
    readonly session: Session,
    readonly channel: NetworkChannel,
    readonly options: {
      room: string;
      identity: string;
      delayMs?: number;
      mode?: NetworkMode;
      clock?: "frames" | "realtime";
      onStatus?(status: NetworkStatus): void;
    },
  ) {
    this.#status = {
      phase: "waiting",
      tick: 0,
      confirmed: 0,
      predicted: 0,
      rollbacks: 0,
      replayedTicks: 0,
      delayMs: options.delayMs ?? 0,
      mode: options.mode ?? "rollback",
    };
  }

  join() {
    const s = this.session;
    if (!s.canStep || !s.game) {
      throw new NetworkError("wait for a successful game build");
    }
    if (s.mode === "play") s.stop();
    let state = s.document.state.slice();
    if (s.game.hasStart && state[1] === 0) {
      const input = idleInput(s.schema, 0, 0);
      input.players = [0, 1].map((id) => ({ ...input, id }));
      state = s.game.start(state, input).state.slice();
    }
    this.channel.send({
      kind: "join",
      room: this.options.room,
      identity: this.options.identity,
      state: Array.from(state),
      names: [...s.names],
      tickRate: s.tickRate,
      mode: this.#status.mode,
      delayMs: this.#status.delayMs,
    });
    this.#publish();
  }

  receive(message: NetworkReceive) {
    if (this.#closed) return;
    try {
      if (message.kind === "closed") {
        this.close(message.reason);
        return;
      }
      if (message.kind === "waiting") return;
      if (message.kind === "prepare") {
        if (this.rollback || message.tickRate !== this.session.tickRate) {
          throw new NetworkError("invalid multiplayer start");
        }
        this.peer = message.peer;
        this.#status = {
          ...this.#status,
          peer: message.peer,
          mode: message.mode,
          delayMs: message.delayMs,
        };
        this.rollback = new Rollback({
          schema: this.session.schema,
          game: this.session.game!,
          state: new Float32Array(message.state),
          peers: [0, 1],
          tickRate: message.tickRate,
          mode: message.mode,
          onFrame: ({ input, before, result }) => {
            this.#events.set(input.tick, result.events);
            this.session.applyDrivenFrame(this, input, before, result);
          },
          onConfirm: (tick, hash) => {
            this.session.presentDrivenEvents(
              this,
              this.#events.get(tick - 1) ?? [],
              tick - 1,
            );
            this.#events.delete(tick - 1);
            if (tick % 15 === 0) {
              this.channel.send({ kind: "hash", tick, hash });
            }
          },
        });
        this.session.drivePlay(
          this,
          this.rollback.state,
          new Map(message.names),
        );
        this.channel.send({ kind: "ready" });
      } else if (message.kind === "go") {
        if (!this.rollback) throw new NetworkError("game was not prepared");
        this.#running = true;
        this.#status.phase = "playing";
        this.channel.send({
          kind: "hash",
          tick: this.rollback.tick,
          hash: this.rollback.hash()!,
        });
        if (this.options.clock === "realtime") {
          let last = performance.now();
          this.#timer = setInterval(() => {
            const now = performance.now();
            this.#advance((now - last) / 1000);
            last = now;
          }, 8);
        }
      } else if (message.kind === "input") {
        this.rollback!.submit(
          message.peer,
          decodeInput(this.session.schema, new Float32Array(message.lanes)),
        );
      } else {
        this.rollback!.receiveHash(message.peer, message.tick, message.hash);
      }
      this.#publish();
    } catch (error) {
      this.close(error instanceof Error ? error.message : String(error));
    }
  }

  advance(seconds: number): boolean {
    return this.#timer === undefined ? this.#advance(seconds) : false;
  }

  #advance(seconds: number): boolean {
    if (!this.#running || this.#closed || !this.rollback) return false;
    const game = this.rollback;
    this.#accumulator += Math.max(0, Math.min(seconds, 0.1));
    let steps = 0;
    try {
      while (this.#accumulator >= game.dt && steps < 8) {
        if (!game.hasInput(this.peer)) {
          const input = this.session.input.sample(
            game.tick,
            game.dt,
            game.tick * game.dt,
          );
          game.submit(this.peer, input);
          this.channel.send({
            kind: "input",
            lanes: Array.from(encodeInput(this.session.schema, input)),
          });
        }
        if (!game.advance()) {
          this.#accumulator = Math.min(this.#accumulator, game.dt);
          break;
        }
        this.#accumulator -= game.dt;
        steps++;
      }
      this.#publish();
    } catch (error) {
      this.close(error instanceof Error ? error.message : String(error));
    }
    return steps > 0;
  }

  get status(): NetworkStatus {
    return this.#status;
  }

  #publish() {
    if (this.rollback) {
      const r = this.rollback;
      this.#status = {
        ...this.#status,
        tick: r.tick,
        confirmed: r.confirmed,
        predicted: r.predicted,
        rollbacks: r.rollbacks,
        replayedTicks: r.replayedTicks,
      };
      // A replay can revisit confirmed frames before its correction. Discard
      // those events without presenting them a second time.
      for (const tick of this.#events.keys()) {
        if (tick < r.confirmed) this.#events.delete(tick);
      }
    }
    this.options.onStatus?.(this.#status);
  }

  close(reason = "Left the room") {
    if (this.#closed) return;
    this.#closed = true;
    this.#running = false;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.channel.send({ kind: "leave" });
    this.channel.close();
    this.#status = { ...this.#status, phase: "closed", reason };
    this.session.releaseDriver(this);
    this.#publish();
  }

  dispose() {
    this.close();
  }
}
