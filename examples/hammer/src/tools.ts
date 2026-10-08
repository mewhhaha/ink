/**
 * Creation tools for the four views: @ink/brushes' block / edit / clip / face
 * tools for geometry, plus `place`, which drops the chosen entity preset at
 * the clicked point. Preset brushes come from @ink/geometry's `boxBrush`.
 */
import { boxBrush, type Vec3, vec3 } from "@ink/geometry";
import { createBrushTools } from "@ink/brushes";
import {
  type Preset,
  type ViewportContext,
  type ViewportTool,
} from "@ink/react";
import { useSyncExternalStore } from "react";

const shape = (
  path: string,
  color: number[],
  extra: Record<string, unknown> = {},
) => ({ shape: path, color: [...color, 1], cast_shadows: false, ...extra });
const wiring = { outputs: { connections: [] } };

/** A box brush centred on its transform; planes are local. */
export function boxComponents(
  size: Vec3,
  texture: string,
  position: Vec3 = [0, 0, 0],
) {
  const half = vec3.scale(size, 0.5);
  const faces = boxBrush(vec3.negate(half), half).map((face) => ({
    ...face,
    texture,
  }));
  return {
    transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    brush: { faces },
  };
}

export interface EntityPreset extends Preset {
  /** Height of the entity's origin above the clicked point. */
  lift: number;
}

export const entityPresets: EntityPreset[] = [
  {
    label: "Door",
    name: "door",
    icon: "door",
    lift: 1.5,
    components: {
      ...boxComponents([3, 3, 0.5], "textures/metal.png"),
      door: {},
      ...wiring,
    },
  },
  {
    label: "Button",
    name: "button",
    icon: "bolt",
    lift: 1.4,
    components: {
      transform: { scale: [0.5, 0.5, 0.2] },
      mesh: {
        shape: "builtin:cube",
        texture: "textures/panel.png",
        emissive: [0.9, 0.15, 0.1, 1],
      },
      push_button: {},
      ...wiring,
    },
  },
  {
    label: "Trigger zone",
    name: "trigger",
    icon: "crosshair",
    lift: 1.5,
    components: {
      transform: { scale: [0.3, 0.3, 0.3] },
      mesh: shape("builtin:cube", [1, 0.55, 0.1], {
        emissive: [1, 0.55, 0.1, 1],
      }),
      trigger_zone: {},
      marker: {},
      ...wiring,
    },
  },
  {
    label: "Lamp",
    name: "lamp",
    icon: "sun",
    lift: 3.2,
    components: {
      transform: { scale: [0.35, 0.12, 0.35] },
      mesh: shape("builtin:cylinder", [1, 0.95, 0.8], {
        emissive: [1, 0.9, 0.65, 1],
      }),
      light: {
        kind: "point",
        color: [1, 0.9, 0.72, 1],
        intensity: 6,
        range: 12,
      },
      lamp: {},
      ...wiring,
    },
  },
  {
    label: "Relay",
    name: "relay",
    icon: "send",
    lift: 1,
    components: {
      transform: { scale: [0.3, 0.3, 0.3] },
      mesh: shape("builtin:cube", [0.5, 0.7, 1], {
        emissive: [0.2, 0.4, 0.9, 1],
      }),
      relay: {},
      marker: {},
      ...wiring,
    },
  },
  {
    label: "Counter",
    name: "counter",
    icon: "layers",
    lift: 1,
    components: {
      transform: { scale: [0.3, 0.3, 0.3] },
      mesh: shape("builtin:cube", [0.9, 0.6, 1], {
        emissive: [0.6, 0.3, 0.9, 1],
      }),
      counter: {},
      marker: {},
      ...wiring,
    },
  },
  {
    label: "Player start",
    name: "player_start",
    icon: "hand",
    lift: 1.6,
    components: {
      transform: { scale: [0.4, 0.4, 0.4] },
      mesh: shape("builtin:cone", [0.3, 0.7, 1], {
        emissive: [0.1, 0.3, 0.6, 1],
      }),
      camera: { fov: 75, near: 0.05, far: 200, active: true },
      player: {},
      marker: {},
    },
  },
];

// The entity the Entity tool places ------------------------------------------------

let current: EntityPreset | null = null;
const listeners = new Set<() => void>();
export const placement = {
  get: () => current,
  set(preset: EntityPreset | null) {
    current = preset;
    for (const listener of listeners) listener();
  },
};
export const usePlacement = () =>
  useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, placement.get);

/** `door` -> `door1`, then `door2`: the next free name for a preset. */
function nextName(ctx: ViewportContext, base: string): string {
  let highest = 0;
  for (const name of ctx.session.names.values()) {
    const match = new RegExp(`^${base}(\\d+)$`).exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${base}${highest + 1}`;
}

export const placeTool: ViewportTool = {
  id: "place",
  label: "Entity",
  icon: "plus",
  shortcut: "N",
  cursor: "crosshair",
  noGizmo: true,
  async pointerDown(ctx, e) {
    const preset = placement.get();
    if (!preset) return false;
    const hit = ctx.kind === "perspective" ? await ctx.pick(e.x, e.y) : null;
    const point = hit?.point ?? ctx.planePoint(e.x, e.y);
    if (!point) return false;
    const at = ctx.snap(point, e.ctrl);
    const components = structuredClone(preset.components) as Record<
      string,
      Record<string, unknown>
    >;
    components.transform = {
      ...components.transform,
      position: [at[0], at[1] + preset.lift, at[2]],
    };
    ctx.session.createEntity({
      name: nextName(ctx, preset.name ?? preset.label.toLowerCase()),
      components,
    });
    return true;
  },
};

export const tools: ViewportTool[] = [...createBrushTools(), placeTool];
