/** JSON scene/comment representation for the shared CRDT; presence stays separate. */
import type { SceneEntity, SceneFile } from "@ink/schema";
import type { Comment } from "./comments.ts";
import { parseComments } from "./comments.ts";
import type { Json } from "./crdt.ts";

export function sharedData(
  scene: SceneFile,
  comments: readonly Comment[],
): Json {
  const entities = Object.fromEntries(
    scene.entities.map((
      entity,
      order,
    ) => [String(entity.id), { ...entity, order }]),
  );
  const threads = Object.fromEntries(comments.map((comment) => [comment.id, {
    ...comment,
    replies: Object.fromEntries(
      (comment.replies ?? []).map((
        reply,
        i,
      ) => [reply.id ?? `imported-${i}-${reply.created}`, reply]),
    ),
  }]));
  const { nextEntity: _, ...rest } = scene;
  // Strip optional undefined fields; JSON is the persisted and exchanged form.
  return JSON.parse(
    JSON.stringify({ scene: { ...rest, entities }, comments: threads }),
  );
}

export function readSharedData(
  value: Json,
): { scene: SceneFile; comments: Comment[] } {
  const data = value as unknown as {
    scene?: Omit<SceneFile, "entities"> & {
      entities?: Record<string, SceneEntity & { order?: number }>;
    };
    comments?: Record<
      string,
      Comment & {
        replies?: Record<string, NonNullable<Comment["replies"]>[number]>;
      }
    >;
  };
  const raw: Partial<NonNullable<typeof data.scene>> = data.scene ?? {};
  const entities = Object.entries(raw.entities ?? {}).map(([id, entity]) => ({
    ...entity,
    id: Number(id),
  }))
    .filter((e) => Number.isInteger(e.id) && e.id > 0 && e.id <= 0xffffff)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id)
    .map(({ order: _, ...e }) => ({ ...e, components: e.components ?? {} }));
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const e of entities) {
    if (!byId.has(e.parent ?? 0)) delete e.parent;
  }
  // Concurrent legal reparentings can form a cycle. Every replica breaks its
  // lowest-id edge in the materialized scene, without dropping either entity.
  for (const e of entities) {
    const path: number[] = [];
    let at: SceneEntity | undefined = e;
    while (at) {
      const index = path.indexOf(at.id);
      if (index >= 0) {
        delete byId.get(Math.min(...path.slice(index)))!.parent;
        break;
      }
      path.push(at.id);
      at = byId.get(at.parent ?? 0);
    }
  }
  const comments = parseComments(
    Object.entries(data.comments ?? {}).map(([id, comment]) => ({
      ...comment,
      id,
      replies: Object.entries(comment.replies ?? {}).map(([id, reply]) => ({
        ...reply,
        id,
      })).sort((a, b) =>
        a.created < b.created
          ? -1
          : a.created > b.created
          ? 1
          : a.id < b.id
          ? -1
          : 1
      ),
    })),
  ).sort((a, b) =>
    a.created < b.created
      ? -1
      : a.created > b.created
      ? 1
      : a.id < b.id
      ? -1
      : 1
  );
  return {
    scene: {
      ...raw,
      ink: 1,
      entities,
      nextEntity: entities.reduce((n, e) => Math.max(n, e.id + 1), 1),
    },
    comments,
  };
}
