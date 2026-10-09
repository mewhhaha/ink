/**
 * Browser client for the Ink dev server: typed fetch wrappers for `/__ink/*`
 * and subscriptions to the `ink:*` HMR events. Works without Vite's `hot`
 * object (production builds): subscriptions become no-ops.
 */
import type { SceneFile, Schema } from "@ink/schema";
import type {
  NetworkChannel,
  NetworkReceive,
  Scenario,
  SharedChannel,
  SharedReceive,
} from "@ink/core";
import type { LiveCommand, LiveSessionInfo } from "./live.ts";
import type { ImportStatus } from "@ink/assets/format";
import type {
  BundleFile,
  BundleResult,
  DevEvents,
  ProjectInfo,
} from "./protocol.ts";
import { type AssetSegment, encodeSegments } from "./segments.ts";

export type * from "./protocol.ts";
export type { AssetSegment } from "./segments.ts";

interface Hot {
  on(event: string, listener: (data: never) => void): void;
  off?(event: string, listener: (data: never) => void): void;
  send(event: string, data: unknown): void;
}

export interface DevClient {
  shared(receive: (message: SharedReceive) => void): SharedChannel;
  multiplayer(receive: (message: NetworkReceive) => void): NetworkChannel;
  connectLive(
    info: LiveSessionInfo,
    call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ): () => void;
  project(): Promise<ProjectInfo>;
  /** Import the project's schema module (`schema.ts`) at its current version. */
  loadSchema(project: ProjectInfo): Promise<Schema>;
  /** Fetch a compiled game revision. */
  game(revision: number): Promise<Uint8Array>;
  assetUrl(path: string, version?: number | string): string;
  /** Current import status of every imported asset. */
  imports(): Promise<ImportStatus[]>;
  /** A cached thumbnail (204 No Content until one exists). */
  thumbnailUrl(path: string, variant?: string, version?: string): string;
  /** Store a thumbnail rendered for the asset content `source`. */
  putThumbnail(
    path: string,
    variant: string,
    source: string,
    png: Blob,
  ): Promise<boolean>;
  /** Create a zero-filled `.terrain` or `.scatter` asset of `size` bytes
   * (rejected if it exists). The catalog picks it up through `ink:project`. */
  createAsset(path: string, size: number): Promise<void>;
  /** Replace a `.terrain`/`.scatter` file whole (atomically); with `create`
   * make a new one instead. */
  putAsset(
    path: string,
    bytes: Uint8Array,
    options?: { create?: boolean },
  ): Promise<void>;
  /** Overwrite byte ranges of an existing `.terrain`/`.scatter` file in
   * place, in one request. The server does not echo it back as `ink:asset`. */
  patchAsset(path: string, segments: readonly AssetSegment[]): Promise<void>;
  scenes(): Promise<string[]>;
  scene(name: string): Promise<SceneFile>;
  scenarios(): Promise<string[]>;
  scenario(name: string): Promise<Scenario>;
  scenarioFileUrl(path: string): string;
  putScene(name: string, scene: SceneFile): Promise<void>;
  comments<T = unknown>(): Promise<T[]>;
  putComments(comments: unknown[]): Promise<void>;
  postHandoff(files: BundleFile[], id?: string): Promise<BundleResult>;
  postCapture(files: BundleFile[], id?: string): Promise<BundleResult>;
  handoffs(): Promise<string[]>;
  captures(): Promise<string[]>;
  handoffFiles(id: string): Promise<string[]>;
  handoffFile(id: string, file: string): Promise<Response>;
  captureFile(id: string, file: string): Promise<Response>;
  /** Subscribe to an HMR event. Returns an unsubscribe function. */
  on<K extends keyof DevEvents>(
    event: K,
    listener: (data: DevEvents[K]) => void,
  ): () => void;
}

const encode = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

export function createDevClient(base = ""): DevClient {
  // @ts-ignore Vite injects `import.meta.hot`; it is absent in production.
  const hot: Hot | undefined = import.meta.hot;
  const url = (path: string) => `${base}/__ink/${path}`;

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(url(path), init);
    if (!response.ok) {
      let detail = response.statusText;
      try {
        detail = ((await response.json()) as { error?: string }).error ??
          detail;
      } catch {
        // not JSON
      }
      throw new Error(
        `ink ${init?.method ?? "GET"} ${path}: ${response.status} ${detail}`,
      );
    }
    return response;
  }
  const getJson = async <T>(path: string) =>
    (await request(path)).json() as Promise<T>;
  const send = (path: string, method: string, body: unknown) =>
    request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const bundle = async (kind: string, files: BundleFile[], id?: string) =>
    (await send(kind, "POST", { id, files })).json() as Promise<BundleResult>;

  return {
    shared(receive) {
      if (!hot) throw new Error("shared editing needs the dev server");
      const channel = crypto.randomUUID();
      const message = (data: { channel: string; message: SharedReceive }) => {
        if (data.channel === channel) receive(data.message);
      };
      const disconnected = () =>
        receive({
          kind: "closed",
          reason: "Server disconnected; leave and rejoin when it is back",
        });
      hot.on("ink:shared", message);
      hot.on("vite:ws:disconnect", disconnected);
      return {
        send: (message) => hot.send("ink:shared", { channel, message }),
        close() {
          hot.off?.("ink:shared", message);
          hot.off?.("vite:ws:disconnect", disconnected);
        },
      };
    },
    multiplayer(receive) {
      if (!hot) throw new Error("multiplayer relay needs the dev server");
      const channel = crypto.randomUUID();
      const message = (data: { channel: string; message: NetworkReceive }) => {
        if (data.channel === channel) receive(data.message);
      };
      const disconnected = () =>
        receive({ kind: "closed", reason: "Server disconnected" });
      hot.on("ink:network", message);
      hot.on("vite:ws:disconnect", disconnected);
      return {
        send: (message) => hot.send("ink:network", { channel, message }),
        close() {
          hot.off?.("ink:network", message);
          hot.off?.("vite:ws:disconnect", disconnected);
        },
      };
    },
    connectLive(info, call) {
      if (!hot) return () => {};
      let queue = Promise.resolve();
      const register = () => hot.send("ink:register", info);
      const command = (request: LiveCommand) => {
        queue = queue.then(async () => {
          try {
            if (request.deadline < Date.now()) {
              throw new Error("command expired before execution");
            }
            const result = await call(request.method, request.params);
            hot.send("ink:result", { id: request.id, result });
          } catch (error) {
            hot.send("ink:result", {
              id: request.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      };
      hot.on("ink:command", command);
      hot.on("vite:ws:connect", register);
      register();
      return () => {
        hot.off?.("ink:command", command);
        hot.off?.("vite:ws:connect", register);
      };
    },
    project: () => getJson("project"),
    async loadSchema(project) {
      if (!project.schemaUrl) throw new Error("the project has no schema");
      const module = await import(/* @vite-ignore */ base + project.schemaUrl);
      return module.default as Schema;
    },
    async game(revision) {
      return new Uint8Array(
        await (await request(`game/${revision}.wasm`)).arrayBuffer(),
      );
    },
    assetUrl: (path, version) =>
      url(`assets/${encode(path)}`) +
      (version === undefined ? "" : `?v=${version}`),
    imports: () => getJson("imports"),
    thumbnailUrl: (path, variant = "asset", version) =>
      url(`thumbs/${encode(path)}`) +
      `?variant=${encodeURIComponent(variant)}` +
      (version ? `&v=${version}` : ""),
    async putThumbnail(path, variant, source, png) {
      const response = await fetch(
        url(`thumbs/${encode(path)}`) +
          `?variant=${encodeURIComponent(variant)}&source=${source}`,
        { method: "PUT", body: png },
      );
      return response.ok;
    },
    async createAsset(path, size) {
      await request(`assets-write/${encode(path)}?create=1&size=${size}`, {
        method: "PUT",
      });
    },
    async putAsset(path, bytes, options) {
      await request(
        `assets-write/${encode(path)}${options?.create ? "?create=1" : ""}`,
        { method: "PUT", body: bytes as BodyInit },
      );
    },
    async patchAsset(path, segments) {
      await request(`assets-write/${encode(path)}`, {
        method: "PATCH",
        body: encodeSegments(segments) as BodyInit,
      });
    },
    scenes: () => getJson("scenes"),
    scenarios: () => getJson("scenarios"),
    scenario: (name) => getJson(`scenarios/${encodeURIComponent(name)}`),
    scenarioFileUrl: (path) => url(`scenario-files/${encode(path)}`),
    scene: (name) => getJson(`scenes/${encodeURIComponent(name)}`),
    async putScene(name, scene) {
      await send(`scenes/${encodeURIComponent(name)}`, "PUT", scene);
    },
    comments: () => getJson("comments"),
    async putComments(comments) {
      await send("comments", "PUT", comments);
    },
    postHandoff: (files, id) => bundle("handoffs", files, id),
    postCapture: (files, id) => bundle("captures", files, id),
    handoffs: () => getJson("handoffs"),
    captures: () => getJson("captures"),
    handoffFiles: (id) => getJson(`handoffs/${encodeURIComponent(id)}`),
    handoffFile: (id, file) =>
      request(`handoffs/${encodeURIComponent(id)}/${encode(file)}`),
    captureFile: (id, file) =>
      request(`captures/${encodeURIComponent(id)}/${encode(file)}`),
    on(event, listener) {
      if (!hot) return () => {};
      const l = listener as (data: never) => void;
      hot.on(event, l);
      return () => hot.off?.(event, l);
    },
  };
}
