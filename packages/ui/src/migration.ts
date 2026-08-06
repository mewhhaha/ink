import { vec2, vec3 } from "@ink/math/vector.ts";
import type { SceneNodeId } from "@ink/scene/identity.ts";
import {
  literal_text,
  type SemanticNode,
  ui_id,
  type UiPlacement,
  type UiSnapshot,
} from "./semantic.ts";

export type LegacySemanticPlacement =
  | {
    readonly type: "scene_object";
    readonly object: number;
    readonly offset: readonly [number, number, number];
    readonly size: readonly [number, number];
  }
  | {
    readonly type: "viewport";
    readonly anchor:
      | "top_left"
      | "top_right"
      | "bottom_left"
      | "bottom_right"
      | "center";
    readonly inset: readonly [number, number];
  };

interface LegacySemanticBase {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly element_size: { readonly width: number; readonly height: number };
  readonly placement: LegacySemanticPlacement;
  readonly order: number;
  readonly actions: readonly {
    readonly id: string;
    readonly label: string;
    readonly action: unknown;
  }[];
}

export type LegacySemanticRegion =
  | (LegacySemanticBase & {
    readonly role: "button";
    readonly pressed: boolean;
    readonly selected: boolean;
    readonly target: number;
  })
  | (LegacySemanticBase & { readonly role: "text" })
  | (LegacySemanticBase & {
    readonly role: "progress";
    readonly maximum: number;
    readonly value: number;
  });

export interface LegacyUiActionBinding {
  readonly node: ReturnType<typeof ui_id>;
  readonly actions: readonly {
    readonly id: string;
    readonly action: unknown;
  }[];
}

export interface LegacyUiMigration {
  readonly snapshot: UiSnapshot;
  readonly actions: readonly LegacyUiActionBinding[];
}

export interface LegacyUiMigrationOptions {
  readonly revision: number;
  readonly viewport_size: { readonly width: number; readonly height: number };
  readonly resolve_scene_object: (object: number) => SceneNodeId;
}

function placement(
  region: LegacySemanticRegion,
  options: LegacyUiMigrationOptions,
): UiPlacement {
  if (region.placement.type === "scene_object") {
    return {
      type: "scene",
      node: options.resolve_scene_object(region.placement.object),
      offset: vec3(
        region.placement.offset[0] / 1_000_000,
        region.placement.offset[1] / 1_000_000,
        region.placement.offset[2] / 1_000_000,
      ),
      size: vec2(
        region.placement.size[0] / 1_000_000,
        region.placement.size[1] / 1_000_000,
      ),
    };
  }
  return {
    type: "viewport",
    anchor: region.placement.anchor,
    inset: vec2(region.placement.inset[0], region.placement.inset[1]),
    size: vec2(region.element_size.width, region.element_size.height),
  };
}

export function migrate_legacy_semantics(
  regions: readonly LegacySemanticRegion[],
  options: LegacyUiMigrationOptions,
): LegacyUiMigration {
  const actions: LegacyUiActionBinding[] = [];
  const children: SemanticNode[] = regions.map((region) => {
    const id = ui_id(region.id);
    actions.push(Object.freeze({
      node: id,
      actions: Object.freeze(
        region.actions.map((action) =>
          Object.freeze({ id: action.id, action: action.action })
        ),
      ),
    }));
    const common = {
      id,
      label: literal_text(region.label),
      description: literal_text(region.description),
      reading_order: region.order,
      focus_order: region.order,
      placement: placement(region, options),
      size: {
        width: region.element_size.width,
        height: region.element_size.height,
      },
      actions: region.actions.map((action) => ({
        id: action.id,
        label: literal_text(action.label),
      })),
    } as const;
    if (region.role === "button") {
      return {
        ...common,
        role: "button",
        pressed: region.pressed,
        selected: region.selected,
      };
    }
    if (region.role === "progress") {
      return {
        ...common,
        role: "progress",
        minimum: 0,
        maximum: region.maximum,
        value: region.value,
      };
    }
    return { ...common, role: "text" };
  });
  const root_source = {
    id: ui_id("legacy.root"),
    role: "region",
    label: literal_text("Game interface"),
    layout: { type: "absolute" as const },
    placement: {
      type: "absolute" as const,
      x: 0,
      y: 0,
      width: options.viewport_size.width,
      height: options.viewport_size.height,
    },
    children: Object.freeze(children),
  } satisfies SemanticNode;
  const root: SemanticNode = Object.freeze(root_source);
  const snapshot: UiSnapshot = Object.freeze({
    revision: options.revision,
    direction: "ltr",
    root,
    announcements: Object.freeze([]),
  });
  return Object.freeze({
    snapshot,
    actions: Object.freeze(actions),
  });
}
