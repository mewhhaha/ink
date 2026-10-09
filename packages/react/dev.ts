/**
 * Connects a Session to the Ink dev server: initial project, schema, scene,
 * game and comments; then hot reloads of Blot code, the schema, assets,
 * scenes and comments, applied in place without a page reload.
 */
import { compileGame, loadGame } from "@ink/blot";
import { prepareWarmup, warmGame } from "@ink/blot/warm";
import { epochNow, parseComments, Session } from "@ink/core";
import type { Renderer } from "@ink/render";
import { idleInput, type SceneFile } from "@ink/schema";
import {
  type ChangeTrace,
  createDevClient,
  type DevClient,
  type ProjectInfo,
} from "@ink/dev/client";

export interface DevConnection {
  client: DevClient;
  project: ProjectInfo;
  saveScene(): Promise<void>;
  openScene(name: string): Promise<void>;
  /** Persist all comment edits made so far, in order. */
  flushComments(): Promise<void>;
  /** Hook the renderer up for asset hot reload once it exists. */
  attachRenderer(renderer: Renderer): void;
  dispose(): void;
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as {
    fromBase64?(text: string): Uint8Array<ArrayBuffer>;
  }).fromBase64;
  if (native) return native.call(Uint8Array, text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function startDev(
  options: { scene?: string; tickRate?: number } = {},
): Promise<{ session: Session; dev: DevConnection }> {
  const client = createDevClient();
  prepareWarmup();
  let project = await client.project();
  if (!project.schemaUrl) {
    throw new Error(
      "the project has no loadable schema.ts; see the dev server output",
    );
  }
  let schema = await client.loadSchema(project);
  const params = new URLSearchParams(location.search);
  const wanted = options.scene ?? params.get("scene") ?? "main";
  const sceneName = project.scenes.includes(wanted)
    ? wanted
    : project.scenes[0] ?? wanted;
  const scene: SceneFile = project.scenes.includes(sceneName)
    ? await client.scene(sceneName)
    : { ink: 1, entities: [] };
  const session = new Session({
    schema,
    catalog: project.catalog,
    scene,
    sceneName,
    tickRate: options.tickRate,
  });
  session.setComments(parseComments(await client.comments().catch(() => [])));
  if (project.game) {
    session.setGame(
      await loadGame(await client.game(project.game.revision), schema),
      project.game,
    );
  }
  if (project.diagnostics.length) session.setBuildErrors(project.diagnostics);

  // Events apply strictly in order: a schema change must land before the
  // game built against it.
  let queue = Promise.resolve();
  const serial =
    <T>(work: (data: T, received: number) => Promise<void>) => (data: T) => {
      const received = epochNow();
      queue = queue.then(() => work(data, received)).catch((error) =>
        session.error(String(error), "dev")
      );
    };
  // Save-to-pixels: the server's stages arrive with the event; the page adds
  // its own and the frame loop finishes the trace when pixels are presented.
  const profiler = session.profiler;
  const open = (trace: ChangeTrace | undefined, received: number) => {
    if (!trace) return;
    // An editor's save is often two file events. A change already installed and
    // waiting for its frame is the same change: let it finish.
    const waiting = profiler.pending;
    if (
      profiler.armed && waiting?.file === trace.file &&
      waiting.kind === trace.kind && waiting.id !== trace.id
    ) return;
    const fresh = profiler.begin(
      trace.id,
      trace.kind,
      trace.file,
      Math.min(trace.written ?? trace.detected, trace.detected),
    );
    if (fresh) {
      profiler.mark("watch", trace.detected);
      if (trace.started) profiler.mark("queue", trace.started);
    }
    if (trace.compiled) profiler.mark("blotc", trace.compiled);
    profiler.mark("prepare", trace.emitted);
    profiler.mark("transport", received);
    if (trace.compile) {
      profiler.detail({
        blotc_ms: Math.round(trace.compile.ms),
        modules_fresh: trace.compile.freshModules,
        modules_cached: trace.compile.cachedModules,
        wasm_bytes: trace.compile.bytes,
      });
    }
  };
  let renderer: Renderer | null = null;
  let savingComments = false;
  const reported = new Map<string, string>();
  const offs = [
    client.on(
      "ink:project",
      serial(async (next, received) => {
        const id = next.trace?.id ?? "";
        open(next.trace, received);
        project = next;
        if (!next.schemaUrl) return;
        schema = await client.loadSchema(next);
        profiler.markFor(id, "schema");
        const layoutChanged = session.setProject(schema, next.catalog);
        profiler.markFor(id, "migrate");
        // New defaults, labels and limits are in the session now. Only a new
        // layout has to wait for the game built against it.
        if (layoutChanged) session.setBuilding();
        else profiler.armFor(id);
      }),
    ),
    client.on(
      "ink:game",
      serial(async (info, received) => {
        const id = info.trace?.id ?? "";
        if (info.unchanged) {
          session.setBuildUnchanged(info.ms);
          // Nothing to load: a trace only records that the build changed
          // nothing, unless a real change is still on its way to the screen.
          if (!profiler.armed) {
            open(info.trace, received);
            profiler.endFor(id, "unchanged");
          }
          return;
        }
        open(info.trace, received);
        const bytes = info.bytes
          ? fromBase64(info.bytes)
          : await client.game(info.revision);
        profiler.markFor(id, "fetch");
        const module = await compileGame(bytes);
        profiler.markFor(id, "wasm");
        // V8 compiles a module's functions on their first call: pay for that
        // in a worker while the old game keeps running, not in the next step.
        await warmGame(
          module,
          schema,
          session.state,
          idleInput(schema, session.tick, session.dt),
        );
        profiler.markFor(id, "warm");
        const game = await loadGame(module, schema);
        profiler.markFor(id, "instantiate");
        session.setGame(game, info);
        profiler.markFor(id, "swap");
        profiler.armFor(id);
      }),
    ),
    client.on(
      "ink:diagnostics",
      serial((event, received) => {
        const id = event.trace?.id ?? "";
        open(event.trace, received);
        session.setBuildErrors(event.diagnostics);
        profiler.endFor(id, "error");
        return Promise.resolve();
      }),
    ),
    client.on(
      "ink:asset",
      serial(async (event, received) => {
        const id = event.trace?.id ?? "";
        open(event.trace, received);
        renderer?.assets.reload(event.path);
        // The new pixels or geometry exist once the reload has been decoded
        // and uploaded; the trace ends at the first frame after that.
        await renderer?.assets.settled();
        session.info(`reloaded ${event.path}`, "dev");
        profiler.markFor(id, "reload");
        profiler.armFor(id);
      }),
    ),
    client.on("ink:imports", ({ statuses }) => {
      for (const s of statuses) {
        const sig = `${s.state}:${s.done.join()}:${s.source}`;
        if (reported.get(s.path) === sig) continue;
        reported.set(s.path, sig);
        const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
        if (s.state === "failed") {
          session.error(`import ${s.path} failed: ${s.message}`, "dev");
        } else if (s.state === "ready" || s.done.length) {
          const stage = s.done[s.done.length - 1];
          session.info(
            `imported ${s.path} (${stage}, ${
              ((s.ms[stage] ?? 0) / 1000).toFixed(1)
            } s, ${mb(s.sourceBytes)} to ${mb(s.outputBytes ?? 0)})`,
            "dev",
          );
        }
      }
    }),
    client.on(
      "ink:scene",
      serial(async (event, received) => {
        if (session.documentDriver) return;
        if (event.name !== session.sceneName || event.removed) return;
        open(event.trace, received);
        const id = event.trace?.id ?? "";
        const scene = event.scene ?? await client.scene(event.name);
        profiler.markFor(id, "fetch");
        if (!session.sceneChangedOnDisk(scene)) {
          return profiler.endFor(id, "unchanged");
        }
        profiler.markFor(id, "apply");
        profiler.armFor(id);
      }),
    ),
    client.on(
      "ink:comments",
      serial(async () => {
        if (session.documentDriver) return;
        if (savingComments) return;
        session.setComments(parseComments(await client.comments()));
      }),
    ),
  ];
  let commentTimer: ReturnType<typeof setTimeout> | undefined;
  let commentWrites = Promise.resolve();
  const flushComments = () => {
    clearTimeout(commentTimer);
    if (session.documentDriver) return session.documentDriver.flush();
    const comments = [...session.comments];
    commentWrites = commentWrites.catch(() => {}).then(async () => {
      savingComments = true;
      try {
        await client.putComments(comments);
      } finally {
        savingComments = false;
      }
    });
    return commentWrites;
  };
  const offComments = session.onComments(() => {
    clearTimeout(commentTimer);
    if (session.documentDriver) return;
    commentTimer = setTimeout(async () => {
      try {
        await flushComments();
      } catch (error) {
        session.error(`could not save comments: ${error}`, "dev");
      }
    }, 150);
  });

  const dev: DevConnection = {
    flushComments,
    client,
    get project() {
      return project;
    },
    async saveScene() {
      try {
        if (session.documentDriver) {
          await session.documentDriver.flush();
          return;
        }
        await client.putScene(session.sceneName, session.toScene());
        session.markSaved();
        session.info(`saved ${session.sceneName}`, "dev");
      } catch (error) {
        session.error(`could not save ${session.sceneName}: ${error}`, "dev");
      }
    },
    async openScene(name) {
      if (
        session.dirty &&
        !confirm(`Discard unsaved changes to ${session.sceneName}?`)
      ) return;
      session.loadScene(await client.scene(name), name);
      const url = new URL(location.href);
      url.searchParams.set("scene", name);
      history.replaceState(null, "", url);
    },
    attachRenderer(r) {
      renderer = r;
    },
    dispose() {
      for (const off of offs) off();
      offComments();
    },
  };
  return { session, dev };
}
