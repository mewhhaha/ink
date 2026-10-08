/** One shared scene per project; durable CRDT registers, transient presence. */
import { join } from "@std/path";
import type { ViteDevServer, WebSocketClient } from "vite";
import {
  CrdtDocument,
  type CrdtEntry,
  parseComments,
  type Presence,
  readSharedData,
  sharedData,
  type SharedReceive,
  type SharedSend,
} from "@ink/core";
import type { SceneFile } from "@ink/schema";
import type { ResolvedProject } from "./node.ts";
import { stableJson } from "./paths.ts";

interface Client {
  socket: WebSocketClient;
  channel: string;
  presence: Presence;
  ranges: [number, number][];
  requests: string[];
}
const colors = [
  "#69a9ff",
  "#ffa65c",
  "#86d797",
  "#dd99f4",
  "#ed7c98",
  "#65dbdf",
];

export class SharedHost {
  #clients = new Map<WebSocketClient, Client>();
  #document?: CrdtDocument;
  #scene = "";
  #nextId = 1;
  #timer?: ReturnType<typeof setTimeout>;
  #queue: Promise<void> = Promise.resolve();
  #saving: Promise<void> = Promise.resolve();
  #closed = false;
  constructor(
    readonly server: ViteDevServer,
    readonly project: ResolvedProject,
    readonly write: (file: string, text: string) => Promise<void>,
  ) {
    server.ws.on("ink:shared", this.receive);
  }

  get activeScene() {
    return this.#clients.size ? this.#scene : null;
  }

  receive = (
    data: { channel: string; message: SharedSend },
    socket: WebSocketClient,
  ) => {
    if (
      typeof data?.channel !== "string" || data.channel.length > 80 ||
      this.#closed
    ) return;
    this.#queue = this.#queue.then(() => this.#handle(data, socket)).catch(
      (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        socket.send({
          type: "custom",
          event: "ink:shared",
          data: { channel: data.channel, message: { kind: "closed", reason } },
        });
        this.#leave(socket);
      },
    );
  };

  async #handle(
    data: { channel: string; message: SharedSend },
    socket: WebSocketClient,
  ) {
    const message = data.message;
    if (message.kind === "join") {
      if (this.#clients.has(socket)) throw new Error("already sharing a scene");
      if (
        !/^[a-zA-Z0-9_-]{1,80}$/.test(message.scene) ||
        typeof message.name !== "string" || !message.name.trim() ||
        message.name.length > 48
      ) throw new Error("invalid scene or display name");
      if (this.#clients.size >= 16) throw new Error("shared session is full");
      if (this.#clients.size && this.#scene !== message.scene) {
        throw new Error(
          `The shared session is editing ${this.#scene}; open that scene first`,
        );
      }
      if (!this.#document || this.#scene !== message.scene) {
        await this.#load(message);
      }
      const actor = crypto.randomUUID();
      const range = this.#reserve();
      const client: Client = {
        socket,
        channel: data.channel,
        ranges: [range],
        requests: [],
        presence: {
          actor,
          name: message.name.trim(),
          color: colors[this.#clients.size % colors.length],
          selection: [],
          cameras: {},
        },
      };
      this.#clients.set(socket, client);
      socket.socket.once("close", () => this.#leave(socket, client));
      // Persist the range before issuing it; a restart can never reuse these ids.
      await this.#save();
      this.#send(client, {
        kind: "ready",
        actor,
        entries: this.#document!.entries(),
        range,
        peers: this.#peers(),
      });
      this.#broadcast({ kind: "presence", peers: this.#peers() });
      return;
    }
    const client = this.#clients.get(socket);
    if (!client || client.channel !== data.channel) return;
    if (message.kind === "leave") {
      this.#leave(socket);
      return;
    }
    if (message.kind === "reserve") {
      const range = this.#reserve();
      client.ranges.push(range);
      await this.#save();
      this.#send(client, { kind: "range", range });
    } else if (message.kind === "presence") {
      if (
        !Array.isArray(message.selection) || message.selection.length > 10000 ||
        !message.selection.every((id) =>
          Number.isInteger(id) && id > 0 && id <= 0xffffff
        ) || !message.cameras || typeof message.cameras !== "object" ||
        JSON.stringify(message.cameras).length > 20000
      ) throw new Error("invalid presence");
      client.presence = {
        ...client.presence,
        selection: message.selection,
        cameras: message.cameras,
      };
      this.#broadcast({ kind: "presence", peers: this.#peers() });
    } else if (message.kind === "ops") {
      if (
        typeof message.request !== "string" || message.request.length > 80 ||
        !Array.isArray(message.entries) || message.entries.length > 100000
      ) throw new Error("invalid operation batch");
      for (const entry of message.entries) {
        if (
          entry.actor !== client.presence.actor ||
          !["scene", "comments"].includes(entry.path[0])
        ) {
          throw new Error(
            "operation does not belong to this author or document",
          );
        }
        if (
          entry.path[0] === "scene" && entry.path[1] === "entities" &&
          entry.path.length > 2
        ) {
          const id = Number(entry.path[2]);
          if (
            !Number.isInteger(id) || id < 1 || id > 0xffffff ||
            (!this.#document!.has(["scene", "entities", String(id)]) &&
              !client.ranges.some(([from, to]) => id >= from && id < to))
          ) throw new Error("entity id is outside the author's allocation");
        }
      }
      this.#document!.merge(message.entries);
      client.requests.push(message.request);
      this.#broadcast({ kind: "ops", entries: message.entries });
      clearTimeout(this.#timer);
      this.#timer = setTimeout(
        () => void this.#save().catch((error) => this.#fail(String(error))),
        120,
      );
    } else if (message.kind === "flush") {
      client.requests.push(message.request);
      await this.#save();
    }
  }

  async #load(message: Extract<SharedSend, { kind: "join" }>) {
    if (
      !message.snapshot || !Array.isArray(message.snapshot.entities) ||
      message.snapshot.entities.some((e) =>
        !e || !Number.isInteger(e.id) || e.id < 1 || e.id >= 0xffffff ||
        !e.components || typeof e.components !== "object"
      ) ||
      new Set(message.snapshot.entities.map((e) => e.id)).size !==
        message.snapshot.entities.length
    ) {
      throw new Error("invalid scene snapshot");
    }
    if (this.#document) await this.#save();
    this.#scene = message.scene;
    this.#document = new CrdtDocument(
      "server",
      sharedData(message.snapshot, parseComments(message.comments)),
    );
    this.#nextId = message.snapshot.entities.reduce(
      (next, e) => Math.max(next, e.id + 1),
      1,
    );
    try {
      const saved = JSON.parse(
        await Deno.readTextFile(
          join(this.project.inkDir, "shared", `${this.#scene}.json`),
        ),
      ) as { entries: CrdtEntry[]; nextId: number };
      const restored = new CrdtDocument("server");
      if (
        !Number.isInteger(saved.nextId) || saved.nextId < 1 ||
        saved.nextId > 0xffffff
      ) throw new Error("invalid saved shared entity allocation");
      restored.merge(saved.entries);
      const disk = JSON.parse(
        await Deno.readTextFile(
          join(this.project.scenesDir, `${this.#scene}.scene.json`),
        ),
      ) as SceneFile;
      const comments = parseComments(
        JSON.parse(
          await Deno.readTextFile(join(this.project.inkDir, "comments.json")),
        ),
      );
      restored.change(
        restored.read(),
        sharedData(disk, comments),
        "Disk changes",
        false,
      );
      this.#document = restored;
      this.#nextId = Math.max(this.#nextId, saved.nextId);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  #reserve(): [number, number] {
    if (this.#nextId + 4096 > 0xffffff) {
      throw new Error("shared entity id space is exhausted");
    }
    const range: [number, number] = [this.#nextId, this.#nextId + 4096];
    this.#nextId += 4096;
    return range;
  }

  /** Source/file edits join the same document, then reach every connected user. */
  async external(scene?: SceneFile, comments?: unknown[]) {
    if (!this.#document) return;
    const current = readSharedData(this.#document.read());
    const next = sharedData(
      scene ?? current.scene,
      comments ? parseComments(comments) : current.comments,
    );
    const entries = this.#document.change(
      this.#document.read(),
      next,
      "Disk changes",
      false,
    );
    if (entries.length) this.#broadcast({ kind: "ops", entries });
    if (scene) {
      this.#nextId = scene.entities.reduce(
        (next, e) => Math.max(next, e.id + 1),
        this.#nextId,
      );
    }
    await this.#save();
  }

  #save(): Promise<void> {
    clearTimeout(this.#timer);
    if (!this.#document) return Promise.resolve();
    const { scene, comments } = readSharedData(this.#document.read());
    const metadata = {
      entries: this.#document.entries(),
      nextId: this.#nextId,
    };
    const name = this.#scene;
    const acknowledgements = [...this.#clients.values()].map((client) => ({
      client,
      requests: client.requests.splice(0),
    }));
    this.#saving = this.#saving.then(async () => {
      await this.write(
        join(this.project.inkDir, "shared", `${name}.json`),
        stableJson(metadata),
      );
      await this.write(
        join(this.project.scenesDir, `${name}.scene.json`),
        stableJson(scene),
      );
      await this.write(
        join(this.project.inkDir, "comments.json"),
        stableJson(comments),
      );
      for (const { client, requests } of acknowledgements) {
        if (requests.length && this.#clients.get(client.socket) === client) {
          this.#send(client, { kind: "ack", requests });
        }
      }
    });
    return this.#saving;
  }

  #peers() {
    return [...this.#clients.values()].map((c) => c.presence);
  }
  #send(client: Client, message: SharedReceive) {
    client.socket.send({
      type: "custom",
      event: "ink:shared",
      data: { channel: client.channel, message },
    });
  }
  #broadcast(message: SharedReceive) {
    for (const client of this.#clients.values()) this.#send(client, message);
  }
  #leave(socket: WebSocketClient, expected = this.#clients.get(socket)) {
    if (!expected || this.#clients.get(socket) !== expected) return;
    this.#clients.delete(socket);
    this.#broadcast({ kind: "presence", peers: this.#peers() });
    void this.#save().catch((error) => this.#fail(String(error)));
  }
  #fail(reason: string) {
    this.#broadcast({ kind: "closed", reason });
    this.#clients.clear();
  }
  async dispose() {
    this.#closed = true;
    this.server.ws.off("ink:shared", this.receive);
    await this.#queue;
    await this.#save();
    this.#fail("Server stopped");
  }
}
