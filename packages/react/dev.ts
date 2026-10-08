/**
 * Connects a Session to the Ink dev server: initial project, schema, scene,
 * game and comments; then hot reloads of Blot code, the schema, assets,
 * scenes and comments, applied in place without a page reload.
 */
import { loadGame } from "@ink/blot";
import { parseComments, Session } from "@ink/core";
import type { Renderer } from "@ink/render";
import type { SceneFile } from "@ink/schema";
import {
  createDevClient,
  type DevClient,
  type ProjectInfo,
} from "@ink/dev/client";

export interface DevConnection {
  client: DevClient;
  project: ProjectInfo;
  saveScene(): Promise<void>;
  openScene(name: string): Promise<void>;
  /** Hook the renderer up for asset hot reload once it exists. */
  attachRenderer(renderer: Renderer): void;
  dispose(): void;
}

export async function startDev(
  options: { scene?: string; tickRate?: number } = {},
): Promise<{ session: Session; dev: DevConnection }> {
  const client = createDevClient();
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
  const serial = <T>(work: (data: T) => Promise<void>) => (data: T) => {
    queue = queue.then(() => work(data)).catch((error) =>
      session.error(String(error), "dev")
    );
  };
  let renderer: Renderer | null = null;
  let savingComments = false;
  const offs = [
    client.on(
      "ink:project",
      serial(async (next) => {
        project = next;
        if (!next.schemaUrl) return;
        schema = await client.loadSchema(next);
        session.setProject(schema, next.catalog);
        session.setBuilding();
      }),
    ),
    client.on(
      "ink:game",
      serial(async (info) => {
        const game = await loadGame(await client.game(info.revision), schema);
        session.setGame(game, info);
      }),
    ),
    client.on(
      "ink:diagnostics",
      serial((event) => {
        session.setBuildErrors(event.diagnostics);
        return Promise.resolve();
      }),
    ),
    client.on(
      "ink:asset",
      serial((event) => {
        renderer?.assets.reload(event.path);
        session.info(`reloaded ${event.path}`, "dev");
        return Promise.resolve();
      }),
    ),
    client.on(
      "ink:scene",
      serial(async (event) => {
        if (event.name !== session.sceneName || event.removed) return;
        session.sceneChangedOnDisk(await client.scene(event.name));
      }),
    ),
    client.on(
      "ink:comments",
      serial(async () => {
        if (savingComments) return;
        session.setComments(parseComments(await client.comments()));
      }),
    ),
  ];
  let commentTimer: ReturnType<typeof setTimeout> | undefined;
  const offComments = session.onComments((comments) => {
    clearTimeout(commentTimer);
    commentTimer = setTimeout(async () => {
      savingComments = true;
      try {
        await client.putComments([...comments]);
      } catch (error) {
        session.error(`could not save comments: ${error}`, "dev");
      } finally {
        setTimeout(() => (savingComments = false), 500);
      }
    }, 150);
  });

  const dev: DevConnection = {
    client,
    get project() {
      return project;
    },
    async saveScene() {
      try {
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
