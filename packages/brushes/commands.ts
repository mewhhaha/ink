import { type Command, type Ink, stationaryBrushTextures } from "@ink/react";
import { mat4, type Vec3 } from "@ink/geometry";
import type { EntityModel } from "@ink/schema";
import { type BrushEntityData, brushWorldBounds, invertible } from "./edit.ts";
import { mergeBrushes, subtractBrush } from "./csg.ts";
import { faceSelection } from "./state.ts";

function selected(ink: Ink) {
  const scene = ink.scene();
  return ink.session.selection.flatMap((id) => {
    const entity = ink.session.entity(id);
    const faces = entity?.components.brush?.faces as unknown as
      | BrushEntityData["faces"]
      | undefined;
    const matrix = scene.matrices.get(id);
    return entity && faces && matrix
      ? [{ entity, data: { matrix, faces } }]
      : [];
  });
}

/** Removing only a brush component keeps children and their transforms intact. */
function removeBrush(
  world: { entities: EntityModel[] },
  names: Map<number, string>,
  id: number,
) {
  if (world.entities.some((e) => e.parent === id)) {
    const entity = world.entities.find((e) => e.id === id)!;
    delete entity.components.brush;
  } else {
    world.entities = world.entities.filter((e) => e.id !== id);
    names.delete(id);
  }
}

function apply(ink: Ink, merge: boolean) {
  const brushes = selected(ink);
  if (brushes.length < 2) return;
  const first = brushes[0];
  const cutter = brushes.at(-1)!;
  if (brushes.some((b) => !invertible(b.data.matrix))) {
    ink.session.warn("CSG needs nonzero brush scales");
    return;
  }
  const merged = merge ? mergeBrushes(brushes.map((b) => b.data)) : null;
  if (merge && !merged) {
    ink.session.warn("Brushes do not form a valid hull");
    return;
  }
  const results = merge
    ? [{ entity: first.entity, pieces: [merged!] }]
    : brushes.slice(0, -1).map((b) => ({
      entity: b.entity,
      pieces: subtractBrush(b.data, cutter.data),
    }));
  const node = ink.session.schema.component("brush")?.fields.find((f) =>
    f.name === "faces"
  )?.node;
  const limit = node?.kind === "list" ? node.field.max ?? Infinity : Infinity;
  if (results.some((r) => r.pieces.some((p) => p.faces.length > limit))) {
    ink.session.warn(`CSG exceeds the schema's ${limit}-face brush limit`);
    return;
  }
  const ids: number[] = [];
  const ok = ink.session.edit(
    merge ? "Convex merge brushes" : "Subtract last brush",
    (world, names) => {
      for (const { entity: source, pieces } of results) {
        if (!pieces.length) {
          removeBrush(world, names, source.id);
          continue;
        }
        pieces.forEach((piece, i) => {
          const entity = i
            ? {
              ...structuredClone(source),
              id: ink.session.allocateEntity(world),
            }
            : world.entities.find((e) => e.id === source.id)!;
          (entity.components.brush as { faces: unknown }).faces =
            structuredClone(piece.faces);
          if (i) {
            world.entities.push(entity);
            names.set(
              entity.id,
              `${names.get(source.id) ?? "Brush"} piece ${i + 1}`,
            );
          }
          ids.push(entity.id);
        });
      }
      const remove = merge ? brushes.slice(1) : [cutter];
      for (const b of remove) removeBrush(world, names, b.entity.id);
    },
  );
  if (ok) {
    ink.session.select(ids);
    faceSelection.clear();
  }
}

export const brushCommands: Command[] = [
  {
    id: "brush-subtract",
    label: "Subtract last selected brush",
    group: "Brushes",
    icon: "scissors",
    shortcut: "Ctrl+Shift+S",
    enabled: (ink) => selected(ink).length >= 2,
    run: (ink) => apply(ink, false),
  },
  {
    id: "brush-merge",
    label: "Convex merge selected brushes",
    group: "Brushes",
    icon: "layers",
    shortcut: "Ctrl+Shift+M",
    enabled: (ink) => selected(ink).length >= 2,
    run: (ink) => apply(ink, true),
  },
];

/** Match world-space bounds to the first selected brush, in one undo step. */
export const brushAlignmentCommands: Command[] = ([0, 1, 2] as const).flatMap((
  axis,
) =>
  (["min", "center", "max"] as const).map((side) => ({
    id: `brush-align-${"xyz"[axis]}-${side}`,
    label: `Align ${"XYZ"[axis]} ${side} to first brush`,
    group: "Alignment",
    enabled: (ink: Ink) => selected(ink).length >= 2,
    run: (ink: Ink) => {
      const scene = ink.scene();
      const brushes = selected(ink);
      const ids = new Set(brushes.map((b) => b.entity.id));
      // A selected child cannot align independently of its selected parent.
      const parents = new Map(
        ink.session.world.entities.map((e) => [e.id, e.parent]),
      );
      const roots = brushes.filter((b) => {
        let parent = b.entity.parent;
        const seen = new Set<number>();
        while (parent && !seen.has(parent)) {
          if (ids.has(parent)) return false;
          seen.add(parent);
          parent = parents.get(parent) ?? 0;
        }
        return true;
      });
      const coordinate = (b: typeof brushes[number]) => {
        const box = brushWorldBounds(b.data);
        return box
          ? side === "center"
            ? (box.min[axis] + box.max[axis]) / 2
            : box[side][axis]
          : null;
      };
      const target = roots[0] && coordinate(roots[0]);
      if (target == null || roots.length < 2) return;
      const updates = roots.slice(1).flatMap((b) => {
        const from = coordinate(b);
        const parent = scene.matrices.get(b.entity.parent) ?? mat4.identity();
        if (from === null || !invertible(parent)) return [];
        const delta: Vec3 = [0, 0, 0];
        delta[axis] = target - from;
        return [{
          id: b.entity.id,
          delta: mat4.transformDirection(mat4.invert(parent), delta),
        }];
      });
      const preserve = stationaryBrushTextures(ink.session.world);
      ink.session.edit(`Align ${"XYZ"[axis]} ${side}`, (world) => {
        for (const update of updates) {
          const transform = world.entities.find((e) => e.id === update.id)
            ?.components.transform;
          if (transform) {
            transform.position = (transform.position as number[]).map((v, i) =>
              v + update.delta[i]
            );
          }
        }
        if (!ink.ui.get().textureLock) preserve(world);
      });
    },
  }))
);
