/**
 * What the editor draws on top of the world: entity I/O wires with arrow
 * heads, trigger volumes, where doors end up, the player's facing. Nothing
 * here enters game state; it is rebuilt every frame from the world.
 */
import {
  brushBounds,
  brushEdges,
  mat4,
  type Plane,
  type Vec3,
  vec3,
} from "@ink/geometry";
import type { Line } from "@ink/render";
import type { ViewportContext } from "@ink/react";
import { connectionsOf, inputColor } from "./io.ts";

type Rgba = [number, number, number, number];

const position = (ctx: ViewportContext, id: number): Vec3 | null => {
  const m = ctx.scene.matrices.get(id);
  return m ? [m[12], m[13], m[14]] : null;
};

function box(min: Vec3, max: Vec3, color: Rgba, width: number): Line[] {
  const c = (
    x: number,
    y: number,
    z: number,
  ): Vec3 => [x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]];
  const edges: [Vec3, Vec3][] = [];
  for (const a of [0, 1]) {
    for (const b of [0, 1]) {
      edges.push([c(0, a, b), c(1, a, b)], [c(a, 0, b), c(a, 1, b)], [
        c(a, b, 0),
        c(a, b, 1),
      ]);
    }
  }
  return edges.map(([from, to]) => ({ from, to, color, width }));
}

const alpha = (c: Rgba, a: number): Rgba => [c[0], c[1], c[2], a];

export function hammerOverlay(ctx: ViewportContext): Line[] {
  if (ctx.kind === "game") return [];
  const { session } = ctx;
  const world = session.world;
  const selected = new Set(session.selection);
  const lines: Line[] = [];
  const eye = ctx.ray(ctx.width / 2, ctx.height / 2).direction;

  for (const entity of world.entities) {
    const here = position(ctx, entity.id);
    if (!here) continue;
    const isSelected = selected.has(entity.id);

    // Trigger volumes.
    const zone = entity.components.trigger_zone;
    const volume = entity.components.brush as
      | { faces: { plane: Plane }[] }
      | undefined;
    if (zone && volume) {
      const color: Rgba = isSelected
        ? [1, 0.7, 0.2, 1]
        : [0.95, 0.55, 0.15, 0.7];
      const matrix = ctx.scene.matrices.get(entity.id)!;
      for (const [a, b] of brushEdges(volume.faces.map((f) => f.plane))) {
        lines.push({
          from: mat4.transformPoint(matrix, a),
          to: mat4.transformPoint(matrix, b),
          color,
          width: isSelected ? 2 : 1,
        });
      }
    }

    // Where a door ends up when open.
    const door = entity.components.door as
      | { offset: Vec3; origin: Vec3 }
      | undefined;
    const brush = entity.components.brush as {
      faces: { plane: [number, number, number, number] }[];
    } | undefined;
    if (door && brush) {
      const bounds = brushBounds(brush.faces.map((f) => f.plane));
      if (bounds) {
        const color: Rgba = isSelected
          ? [0.5, 0.8, 1, 1]
          : [0.4, 0.65, 0.95, 0.55];
        // While playing the door moves; its open position is relative to where it started.
        const home = session.mode === "play" ? door.origin : here;
        const open = vec3.add(home, door.offset);
        const shift = vec3.sub(open, here);
        lines.push(
          ...box(
            vec3.add(bounds.min, open),
            vec3.add(bounds.max, open),
            color,
            1,
          ),
        );
        lines.push({
          from: here,
          to: vec3.add(here, shift),
          color: alpha(color, 0.8),
          width: 1,
        });
      }
    }

    // The player's facing.
    const player = entity.components.player as { yaw: number } | undefined;
    if (player) {
      const yaw = (player.yaw * Math.PI) / 180;
      const tip = vec3.add(here, [
        -Math.sin(yaw) * 1.6,
        0,
        -Math.cos(yaw) * 1.6,
      ]);
      lines.push({ from: here, to: tip, color: [0.4, 0.8, 1, 1], width: 2 });
    }

    // Wires.
    connectionsOf(entity).forEach((connection) => {
      const there = position(ctx, connection.target);
      if (!there) return;
      const target = connection.target;
      const bright = isSelected || selected.has(target) ||
        session.hovered === entity.id || session.hovered === target;
      const base = inputColor(connection.input);
      const color = alpha(base, bright ? 1 : 0.5);
      const width = bright ? 2 : 1;
      lines.push({ from: here, to: there, color, width });
      // Arrow head, a little short of the target, drawn in the view's plane.
      const delta = vec3.sub(there, here);
      const length = vec3.length(delta);
      if (length < 1e-4) return;
      const direction = vec3.scale(delta, 1 / length);
      const size = Math.min(length * 0.4, ctx.pixel(there) * (bright ? 12 : 9));
      const tip = vec3.sub(
        there,
        vec3.scale(direction, Math.min(length * 0.15, ctx.pixel(there) * 6)),
      );
      const side = vec3.normalize(vec3.cross(direction, eye));
      const back = vec3.sub(tip, vec3.scale(direction, size));
      lines.push({
        from: tip,
        to: vec3.add(back, vec3.scale(side, size * 0.45)),
        color,
        width,
      });
      lines.push({
        from: tip,
        to: vec3.sub(back, vec3.scale(side, size * 0.45)),
        color,
        width,
      });
    });
  }
  return lines;
}
