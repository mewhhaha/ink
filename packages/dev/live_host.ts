/** Routes requests to a specific open browser, never a shadow/headless session. */
import type { ViteDevServer, WebSocketClient } from "vite";
import type { IncomingMessage } from "node:http";
import { relative, sep } from "node:path";
import { resolveInside } from "./paths.ts";
import {
  liveMethods,
  liveObject,
  type LiveResult,
  type LiveSessionInfo,
  liveString,
  liveTools,
} from "./live.ts";

interface Client {
  info: LiveSessionInfo;
  socket: WebSocketClient;
}
interface Pending {
  client: Client;
  finish(result: LiveResult): void;
}

export class LiveHost {
  #clients = new Map<string, Client>();
  #pending = new Map<string, Pending>();
  #sourceQueue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly server: ViteDevServer,
    readonly projectDir: string,
    readonly timeout = 30000,
  ) {
    server.ws.on("ink:register", (data: LiveSessionInfo, socket) => {
      if (
        typeof data?.id !== "string" || typeof data.title !== "string" ||
        typeof data.url !== "string"
      ) return;
      const previous = this.#clients.get(data.id);
      if (previous) this.#disconnect(previous);
      const client = { info: data, socket };
      this.#clients.set(data.id, client);
      socket.socket.once("close", () => this.#disconnect(client));
    });
    server.ws.on("ink:result", (data: LiveResult, socket) => {
      const pending = this.#pending.get(data?.id);
      if (pending && pending.client.socket === socket) pending.finish(data);
    });
  }

  list() {
    return [...this.#clients.values()].map((c) => c.info);
  }

  #disconnect(client: Client) {
    if (this.#clients.get(client.info.id) === client) {
      this.#clients.delete(client.info.id);
    }
    for (const [id, pending] of this.#pending) {
      if (pending.client === client) {
        pending.finish({ id, error: "editor disconnected" });
      }
    }
  }

  dispose() {
    for (const client of this.#clients.values()) this.#disconnect(client);
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!liveMethods.has(method)) {
      throw new Error(`unknown live method: ${method}`);
    }
    if (method === "sessions") return this.list();
    if (method === "source") {
      const run = this.#sourceQueue.then(() => this.#source(params));
      this.#sourceQueue = run.catch(() => {});
      return await run;
    }
    const id = params.session;
    if (!id && this.#clients.size !== 1) {
      throw new Error(
        this.#clients.size
          ? "several editors are open; specify session"
          : "no editor is connected; open the project in a browser",
      );
    }
    const client = id
      ? this.#clients.get(String(id))
      : this.#clients.values().next().value;
    if (!client) throw new Error(`unknown editor session: ${id}`);
    const commandId = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          finish({
            id: commandId,
            error:
              "editor command timed out; inspect state before retrying a mutation",
          }),
        this.timeout,
      );
      const finish = (data: LiveResult) => {
        clearTimeout(timer);
        this.#pending.delete(commandId);
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      this.#pending.set(commandId, { client, finish });
      client.socket.send({
        type: "custom",
        event: "ink:command",
        data: {
          id: commandId,
          method,
          params,
          deadline: Date.now() + this.timeout,
        },
      });
    });
  }

  async #source(params: Record<string, unknown>) {
    const path = liveString(params.path, "path");
    const file = resolveInside(this.projectDir, path);
    if (
      path.split("/").some((p) => p.startsWith(".")) ||
      !/\.(blot|tsx?|css|json)$/.test(path) || /\.gen\.(blot|ts)$/.test(path)
    ) {
      throw new Error(
        "source must be a project .blot, .ts, .tsx, .css or .json file, outside hidden/generated files",
      );
    }
    const real = await Deno.realPath(file);
    const root = await Deno.realPath(this.projectDir);
    const rel = relative(root, real);
    if (rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("source symlink escapes the project");
    }
    if (rel.split(sep).some((part) => part.startsWith("."))) {
      throw new Error("hidden source paths are not allowed");
    }
    const current = await Deno.readTextFile(real);
    const hash = async (text: string) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
        ),
        (v) => v.toString(16).padStart(2, "0"),
      ).join("");
    const currentHash = await hash(current);
    if (params.text === undefined) {
      return { path, text: current, hash: currentHash };
    }
    if (typeof params.text !== "string") {
      throw new Error("text must be a string");
    }
    if (params.expectedHash !== currentHash) {
      throw new Error("source changed; read it again before writing");
    }
    await Deno.writeTextFile(real, params.text);
    return { path, hash: await hash(params.text) };
  }

  async mcp(value: unknown) {
    const request = liveObject(value);
    const id = request.id ?? null;
    const error = (code: number, message: string) => ({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return error(-32600, "Invalid request");
    }
    if (request.id === undefined) return null;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    if (request.method === "initialize") {
      const version = liveObject(request.params).protocolVersion;
      return ok({
        protocolVersion: version === "2025-06-18" ? version : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "ink", version: "0.1.0" },
      });
    }
    if (request.method === "ping") return ok({});
    if (request.method === "tools/list") return ok({ tools: liveTools });
    if (request.method !== "tools/call") {
      return error(-32601, "Method not found");
    }
    const params = liveObject(request.params);
    if (
      typeof params.name !== "string" ||
      !liveTools.some((t) => t.name === params.name)
    ) return error(-32602, "Unknown tool");
    try {
      const result = await this.call(
        params.name.slice(4),
        params.arguments === undefined ? {} : liveObject(params.arguments),
      );
      const content: unknown[] = [{
        type: "text",
        text: JSON.stringify(result),
      }];
      // Capture tools return actual image content to vision-capable agents.
      if (
        result && typeof result === "object" && "png" in result &&
        typeof result.png === "string"
      ) {
        content[0] = {
          type: "text",
          text: JSON.stringify({ ...result, png: undefined }),
        };
        content.push({
          type: "image",
          mimeType: "image/png",
          data: result.png.split(",")[1],
        });
      }
      return ok({ content });
    } catch (cause) {
      return ok({
        isError: true,
        content: [{
          type: "text",
          text: String(cause instanceof Error ? cause.message : cause),
        }],
      });
    }
  }
}

/** Match the dev server origin; Vite additionally validates allowed hosts. */
export function validLiveOrigin(req: IncomingMessage): boolean {
  if (!req.headers.origin) return true; // local CLI/MCP clients have no Origin
  try {
    const origin = new URL(req.headers.origin);
    return (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.host === req.headers.host;
  } catch {
    return false;
  }
}
