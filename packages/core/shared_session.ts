import type { SceneFile } from "@ink/schema";
import type { CameraPose, Comment } from "./comments.ts";
import { CrdtDocument, type CrdtEntry } from "./crdt.ts";
import { readSharedData, sharedData } from "./shared_document.ts";
import type { DocumentDriver, Session, Snapshot } from "./session.ts";

export interface Presence {
  actor: string;
  name: string;
  color: string;
  selection: number[];
  cameras: Record<string, CameraPose>;
}
export type SharedSend =
  | {
    kind: "join";
    scene: string;
    name: string;
    snapshot: SceneFile;
    comments: Comment[];
  }
  | { kind: "ops"; request: string; entries: CrdtEntry[] }
  | {
    kind: "presence";
    selection: number[];
    cameras: Record<string, CameraPose>;
  }
  | { kind: "flush"; request: string }
  | { kind: "reserve" | "leave" };
export type SharedReceive =
  | {
    kind: "ready";
    actor: string;
    entries: CrdtEntry[];
    range: [number, number];
    peers: Presence[];
  }
  | { kind: "ops"; entries: CrdtEntry[] }
  | { kind: "range"; range: [number, number] }
  | { kind: "presence"; peers: Presence[] }
  | { kind: "ack"; requests: string[] }
  | { kind: "closed"; reason: string };
export interface SharedChannel {
  send(message: SharedSend): void;
  close(): void;
}

/** Local gestures become field operations; received operations never enter undo. */
export class SharedSession implements DocumentDriver {
  document?: CrdtDocument;
  actor = "";
  available = false;
  peers: Presence[] = [];
  error = "";
  version = 0;
  #listeners = new Set<() => void>();
  #timer?: ReturnType<typeof setInterval>;
  #offDispose: () => void;
  #ranges: [number, number][] = [];
  #reserving = false;
  #offComments?: () => void;
  #closed = false;
  #previousComments: readonly Comment[] = [];
  #pending = new Map<
    string,
    {
      resolve(): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #writes = new Set<Promise<void>>();

  constructor(
    readonly session: Session,
    readonly channel: SharedChannel,
    readonly getPresence?: () => Pick<Presence, "selection" | "cameras">,
  ) {
    this.#offDispose = session.onDispose(() => this.dispose());
  }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #notify() {
    this.version++;
    for (const listener of this.#listeners) listener();
  }

  join(name: string) {
    this.channel.send({
      kind: "join",
      scene: this.session.sceneName,
      name,
      snapshot: this.session.toScene(),
      comments: [...this.session.comments],
    });
  }

  receive(message: SharedReceive) {
    if (this.#closed) return;
    try {
      if (message.kind === "ready") {
        this.actor = message.actor;
        this.document = new CrdtDocument(message.actor);
        this.document.merge(message.entries);
        this.#ranges = [message.range];
        this.peers = message.peers;
        this.available = true;
        this.session.attachDocument(this);
        this.#apply();
        this.#offComments = this.session.onComments((comments) => {
          if (!this.available) return;
          const scene = this.session.toScene();
          this.#send(
            this.document!.change(
              sharedData(scene, this.#previousComments),
              sharedData(scene, comments),
              "Comment",
              false,
            ),
          );
          this.#previousComments = structuredClone(comments);
          this.#apply();
        });
        let previous = "";
        if (this.getPresence) {
          this.#timer = setInterval(() => {
            const value = this.getPresence!();
            const next = JSON.stringify(value);
            if (next !== previous) {
              previous = next;
              this.presence(value.selection, value.cameras);
            }
          }, 250);
        }
      } else if (message.kind === "ops") {
        this.document!.merge(message.entries);
        this.#apply();
      } else if (message.kind === "range") {
        this.#ranges.push(message.range);
        this.#reserving = false;
      } else if (message.kind === "presence") this.peers = message.peers;
      else if (message.kind === "ack") {
        for (const request of message.requests) {
          const pending = this.#pending.get(request);
          if (pending) {
            clearTimeout(pending.timer);
            this.#pending.delete(request);
            pending.resolve();
          }
        }
        if (!this.#pending.size) this.session.markSaved();
      } else this.#disconnect(message.reason);
      this.#notify();
    } catch (error) {
      this.#disconnect(error instanceof Error ? error.message : String(error));
    }
  }

  #apply() {
    const { scene, comments } = readSharedData(this.document!.read());
    this.#previousComments = comments;
    this.session.receiveDocument(scene);
    this.session.dirty = this.#pending.size > 0;
    this.session.setComments(comments);
  }

  refresh() {
    if (this.document) this.#apply();
  }

  change(before: Snapshot, after: Snapshot, label: string) {
    if (!this.available) return;
    const scene = (snapshot: Snapshot) => this.session.toScene(snapshot);
    this.#send(
      this.document!.change(
        sharedData(scene(before), this.session.comments),
        sharedData(scene(after), this.session.comments),
        label,
      ),
    );
    this.#apply();
  }
  begin(label: string) {
    if (!this.available) return;
    this.document?.begin(label);
  }
  commit() {
    this.document?.commit();
    this.#notify();
  }
  cancel() {
    if (!this.available) return;
    this.#send(this.document!.cancel());
    this.#apply();
  }
  undo() {
    if (!this.available) return;
    this.#send(this.document!.undo());
    this.#apply();
  }
  redo() {
    if (!this.available) return;
    this.#send(this.document!.redo());
    this.#apply();
  }
  history() {
    return this.document?.history() ?? { undo: [], redo: [] };
  }

  allocateEntity(): number {
    if (!this.available) throw new Error("shared editing is disconnected");
    while (this.#ranges.length && this.#ranges[0][0] >= this.#ranges[0][1]) {
      this.#ranges.shift();
    }
    const range = this.#ranges[0];
    if (!range) throw new Error("waiting for shared entity ids; try again");
    if (range[1] - range[0] < 128 && !this.#reserving) {
      this.#reserving = true;
      this.channel.send({ kind: "reserve" });
    }
    return range[0]++;
  }

  presence(selection: readonly number[], cameras: Record<string, CameraPose>) {
    if (this.available) {
      this.channel.send({
        kind: "presence",
        selection: [...selection],
        cameras,
      });
    }
  }

  #ack(request: string): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request);
        reject(
          new Error(
            "shared changes were not saved; reconnect or export the scene",
          ),
        );
      }, 15000);
      this.#pending.set(request, { resolve, reject, timer });
    });
    this.#writes.add(promise);
    void promise.catch((error) => this.#disconnect(String(error))).finally(() =>
      this.#writes.delete(promise)
    );
    return promise;
  }

  #send(entries: CrdtEntry[]) {
    if (!entries.length || !this.available) return;
    const request = crypto.randomUUID();
    this.#ack(request);
    this.channel.send({ kind: "ops", request, entries });
  }

  async flush() {
    if (!this.available) {
      throw new Error(this.error || "shared editing is disconnected");
    }
    const request = crypto.randomUUID();
    const ack = this.#ack(request);
    this.channel.send({ kind: "flush", request });
    await Promise.all([...this.#writes, ack]);
  }

  #disconnect(reason: string) {
    clearInterval(this.#timer);
    this.available = false;
    this.error = reason;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
    this.#notify();
  }

  dispose() {
    if (this.#closed) return;
    this.#closed = true;
    this.available = false;
    this.#offComments?.();
    this.#offDispose();
    this.channel.send({ kind: "leave" });
    this.channel.close();
    this.session.detachDocument(this);
    this.#disconnect("Left the shared session");
  }
}
