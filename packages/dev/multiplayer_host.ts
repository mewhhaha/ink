/** A development relay. The clients simulate; it assigns ids and relays inputs. */
import type { ViteDevServer, WebSocketClient } from "vite";
import type { JoinGame, NetworkReceive, NetworkSend } from "@ink/core";

interface Client {
  socket: WebSocketClient;
  channel: string;
  room: Room;
  peer: number;
  ready: boolean;
}
interface Room {
  config: JoinGame;
  clients: Client[];
  started: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
}

export class MultiplayerHost {
  #clients = new Map<WebSocketClient, Client>();
  #rooms = new Map<string, Room>();
  constructor(readonly server: ViteDevServer) {
    server.ws.on("ink:network", this.receive);
  }

  receive = (
    data: { channel: string; message: NetworkSend },
    socket: WebSocketClient,
  ) => {
    if (typeof data?.channel !== "string" || data.channel.length > 80) return;
    try {
      const message = data.message;
      if (message?.kind === "join") {
        if (this.#clients.has(socket)) {
          throw new Error("this browser is already in a room");
        }
        this.#join(socket, data.channel, message);
        return;
      }
      const client = this.#clients.get(socket);
      if (!client || client.channel !== data.channel) return;
      const room = client.room;
      if (message.kind === "leave") {
        this.#close(room, "A player left the room");
        return;
      }
      if (message.kind === "ready") {
        client.ready = true;
        if (
          !room.started && room.clients.length === 2 &&
          room.clients.every((c) => c.ready)
        ) {
          room.started = true;
          for (const c of room.clients) this.#send(c, { kind: "go" });
        }
        return;
      }
      if (!room.started) throw new Error("the room has not started");
      let relay: NetworkReceive;
      if (message.kind === "input") {
        if (!finiteArray(message.lanes, 4096) || message.lanes.length < 23) {
          throw new Error("invalid input packet");
        }
        relay = { kind: "input", peer: client.peer, lanes: message.lanes };
      } else if (message.kind === "hash") {
        if (
          !Number.isInteger(message.tick) || message.tick < 0 ||
          !/^[0-9a-f]{8}$/.test(message.hash)
        ) throw new Error("invalid state hash");
        relay = {
          kind: "hash",
          peer: client.peer,
          tick: message.tick,
          hash: message.hash,
        };
      } else throw new Error("unknown network message");
      const other = room.clients.find((c) => c !== client)!;
      if (room.config.delayMs) {
        if (room.timers.size >= 512) {
          throw new Error("input rate exceeds the relay limit");
        }
        const timer = setTimeout(() => {
          room.timers.delete(timer);
          if (this.#clients.get(other.socket) === other) {
            this.#send(other, relay);
          }
        }, room.config.delayMs);
        room.timers.add(timer);
      } else this.#send(other, relay);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const client = this.#clients.get(socket);
      if (client) this.#close(client.room, reason);
      else {socket.send({
          type: "custom",
          event: "ink:network",
          data: { channel: data.channel, message: { kind: "closed", reason } },
        });}
    }
  };

  #join(socket: WebSocketClient, channel: string, config: JoinGame) {
    if (
      typeof config.room !== "string" ||
      !/^[a-zA-Z0-9_-]{1,48}$/.test(config.room) ||
      typeof config.identity !== "string" || config.identity.length > 2048 ||
      !finiteArray(config.state, 1_000_000) || config.state.length < 7 ||
      !Number.isInteger(config.tickRate) || config.tickRate < 1 ||
      config.tickRate > 240 ||
      !Number.isInteger(config.delayMs) || config.delayMs < 0 ||
      config.delayMs > 200 ||
      !["rollback", "lockstep"].includes(config.mode) ||
      !Array.isArray(config.names) || config.names.length > 100_000 ||
      !config.names.every((n) =>
        Array.isArray(n) && n.length === 2 && Number.isInteger(n[0]) &&
        n[0] > 0 && n[0] <= 0xffffff && typeof n[1] === "string" &&
        n[1].length <= 256
      )
    ) throw new Error("invalid room, snapshot or network settings");
    let room = this.#rooms.get(config.room);
    if (room) {
      if (room.clients.length >= 2) throw new Error("room is full");
      if (
        room.config.identity !== config.identity ||
        room.config.tickRate !== config.tickRate
      ) {
        throw new Error(
          "room uses a different game build or scene; reload both browsers",
        );
      }
    } else {
      if (this.#rooms.size >= 64) throw new Error("too many rooms");
      room = { config, clients: [], started: false, timers: new Set() };
      this.#rooms.set(config.room, room);
    }
    const client: Client = {
      socket,
      channel,
      room,
      peer: room.clients.length,
      ready: false,
    };
    room.clients.push(client);
    this.#clients.set(socket, client);
    socket.socket.once("close", () => {
      if (this.#clients.get(socket) === client) {
        this.#close(client.room, "A player disconnected");
      }
    });
    if (room.clients.length === 1) {
      this.#send(client, { kind: "waiting", room: config.room });
    } else {for (const c of room.clients) {
        this.#send(c, {
          kind: "prepare",
          peer: c.peer,
          state: room.config.state,
          names: room.config.names,
          tickRate: room.config.tickRate,
          mode: room.config.mode,
          delayMs: room.config.delayMs,
        });
      }}
  }

  #send(client: Client, message: NetworkReceive) {
    client.socket.send({
      type: "custom",
      event: "ink:network",
      data: { channel: client.channel, message },
    });
  }

  #close(room: Room, reason: string) {
    for (const timer of room.timers) clearTimeout(timer);
    room.timers.clear();
    this.#rooms.delete(room.config.room);
    for (const client of room.clients) {
      this.#clients.delete(client.socket);
      this.#send(client, { kind: "closed", reason });
    }
  }

  dispose() {
    this.server.ws.off("ink:network", this.receive);
    for (const room of this.#rooms.values()) {
      this.#close(room, "Server stopped");
    }
  }
}

function finiteArray(value: unknown, max: number): value is number[] {
  return Array.isArray(value) && value.length <= max &&
    value.every((n) => typeof n === "number" && Number.isFinite(n));
}
