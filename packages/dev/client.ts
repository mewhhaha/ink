/**
 * Browser client for the Ink dev server: typed fetch wrappers for `/__ink/*`
 * and subscriptions to the `ink:*` HMR events. Works without Vite's `hot`
 * object (production builds): subscriptions become no-ops.
 */
import type { SceneFile, Schema } from "@ink/schema";
import type { Scenario } from "@ink/core";
import type {
  BundleFile,
  BundleResult,
  DevEvents,
  ProjectInfo,
} from "./protocol.ts";

export type * from "./protocol.ts";

interface Hot {
  on(event: string, listener: (data: never) => void): void;
  off?(event: string, listener: (data: never) => void): void;
}

export interface DevClient {
  project(): Promise<ProjectInfo>;
  /** Import the project's schema module (`schema.ts`) at its current version. */
  loadSchema(project: ProjectInfo): Promise<Schema>;
  /** Fetch a compiled game revision. */
  game(revision: number): Promise<Uint8Array>;
  assetUrl(path: string, version?: number | string): string;
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
