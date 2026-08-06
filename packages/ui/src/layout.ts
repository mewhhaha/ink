import type { Observer } from "@ink/observability/observer.ts";
import type { SceneNodeId } from "@ink/scene/identity.ts";
import type { Vec2, Vec3 } from "@ink/math/vector.ts";
import {
  flatten_semantic_tree,
  type SemanticNode,
  type UiId,
  type UiPlacement,
  type UiSnapshot,
} from "./semantic.ts";

export interface UiRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SceneUiProjector {
  project(node: SceneNodeId, offset: Vec3, size: Vec2): UiRect | null;
}

export interface UiLayoutInput {
  readonly viewport: Vec2;
  readonly player_scale: number;
  readonly reduced_motion: boolean;
  readonly scene?: SceneUiProjector;
  readonly observer?: Observer;
}

export interface UiLayoutEntry {
  readonly id: UiId;
  readonly role: SemanticNode["role"];
  readonly rect: UiRect;
  readonly reading_order: number;
  readonly focus_order: number;
}

export type UiLayoutResult =
  | {
    readonly type: "ready";
    readonly entries: readonly UiLayoutEntry[];
    readonly reduced_motion: boolean;
  }
  | { readonly type: "rejected"; readonly node: UiId; readonly reason: string };

function rect(x: number, y: number, width: number, height: number): UiRect {
  if (
    ![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0
  ) {
    throw new Error(
      `UI rectangle (${x}, ${y}, ${width}, ${height}) must be finite with nonnegative size`,
    );
  }
  return Object.freeze({ x, y, width, height });
}

function placed_rect(
  placement: UiPlacement | undefined,
  fallback: UiRect,
  input: UiLayoutInput,
): UiRect | null {
  if (placement === undefined || placement.type === "flow") return fallback;
  const scale = input.player_scale;
  if (placement.type === "absolute") {
    return rect(
      placement.x * scale,
      placement.y * scale,
      placement.width * scale,
      placement.height * scale,
    );
  }
  if (placement.type === "scene") {
    return input.scene?.project(
      placement.node,
      placement.offset,
      placement.size,
    ) ?? null;
  }
  const width = placement.size.x * scale;
  const height = placement.size.y * scale;
  const inset_x = placement.inset.x * scale;
  const inset_y = placement.inset.y * scale;
  const x =
    placement.anchor === "top_right" || placement.anchor === "bottom_right"
      ? input.viewport.x - inset_x - width
      : placement.anchor === "center"
      ? (input.viewport.x - width) / 2 + inset_x
      : inset_x;
  const y =
    placement.anchor === "bottom_left" || placement.anchor === "bottom_right"
      ? input.viewport.y - inset_y - height
      : placement.anchor === "center"
      ? (input.viewport.y - height) / 2 + inset_y
      : inset_y;
  return rect(x, y, width, height);
}

export function layout_ui(
  snapshot: UiSnapshot,
  input: UiLayoutInput,
): UiLayoutResult {
  if (!Number.isFinite(input.player_scale) || input.player_scale <= 0) {
    return {
      type: "rejected",
      node: snapshot.root.id,
      reason: `player scale ${input.player_scale} must be finite and positive`,
    };
  }
  if (
    !Number.isFinite(input.viewport.x) || !Number.isFinite(input.viewport.y) ||
    input.viewport.x <= 0 || input.viewport.y <= 0
  ) {
    return {
      type: "rejected",
      node: snapshot.root.id,
      reason:
        `viewport ${input.viewport.x}x${input.viewport.y} must be finite and positive`,
    };
  }
  const traversal = flatten_semantic_tree(snapshot.root);
  const order = new Map(traversal.map((node, index) => [node.id, index]));
  const entries: UiLayoutEntry[] = [];
  const visit = (
    node: SemanticNode,
    available: UiRect,
  ): UiLayoutResult | null => {
    const positioned = placed_rect(node.placement, available, input);
    if (positioned === null) {
      return {
        type: "rejected",
        node: node.id,
        reason: "scene attachment could not be projected",
      };
    }
    entries.push(Object.freeze({
      id: node.id,
      role: node.role,
      rect: positioned,
      reading_order: node.reading_order ?? order.get(node.id)!,
      focus_order: node.focus_order ?? node.reading_order ??
        order.get(node.id)!,
    }));
    if (!("children" in node) || node.children.length === 0) return null;
    const scale = input.player_scale;
    const padding =
      (node.layout.type === "absolute" ? 0 : node.layout.padding) * scale;
    const gap = (node.layout.type === "absolute" ? 0 : node.layout.gap) * scale;
    const inner = rect(
      positioned.x + padding,
      positioned.y + padding,
      Math.max(0, positioned.width - padding * 2),
      Math.max(0, positioned.height - padding * 2),
    );
    if (node.layout.type === "absolute") {
      for (const child of node.children) {
        const width = (child.size?.width ?? 32) * scale;
        const height = (child.size?.height ?? 32) * scale;
        const failure = visit(child, rect(inner.x, inner.y, width, height));
        if (failure !== null) return failure;
      }
      return null;
    }
    if (node.layout.type === "grid") {
      const columns = node.layout.columns;
      const cell_width = Math.max(
        0,
        (inner.width - gap * (columns - 1)) / columns,
      );
      const row_height = Math.max(
        0,
        ...node.children.map((child) => (child.size?.height ?? 32) * scale),
      );
      for (const [index, child] of node.children.entries()) {
        const logical_column = index % columns;
        const column = snapshot.direction === "rtl"
          ? columns - logical_column - 1
          : logical_column;
        const row = Math.floor(index / columns);
        const failure = visit(
          child,
          rect(
            inner.x + column * (cell_width + gap),
            inner.y + row * (row_height + gap),
            cell_width,
            row_height,
          ),
        );
        if (failure !== null) return failure;
      }
      return null;
    }
    const horizontal = node.layout.direction === "row";
    const total_gap = gap * Math.max(0, node.children.length - 1);
    const fixed = node.children.reduce(
      (sum, child) =>
        sum +
        ((horizontal ? child.size?.width : child.size?.height) ?? 32) * scale,
      0,
    );
    const total_grow = node.children.reduce(
      (sum, child) => sum + (child.size?.grow ?? 0),
      0,
    );
    const spare = Math.max(
      0,
      (horizontal ? inner.width : inner.height) - fixed - total_gap,
    );
    const children = horizontal && snapshot.direction === "rtl"
      ? [...node.children].reverse()
      : node.children;
    let cursor = horizontal ? inner.x : inner.y;
    for (const child of children) {
      const main =
        ((horizontal ? child.size?.width : child.size?.height) ?? 32) * scale +
        (total_grow === 0 ? 0 : spare * (child.size?.grow ?? 0) / total_grow);
      const cross = ((horizontal ? child.size?.height : child.size?.width) ??
        (horizontal ? inner.height : inner.width) / scale) * scale;
      const failure = visit(
        child,
        horizontal
          ? rect(cursor, inner.y, main, Math.min(inner.height, cross))
          : rect(inner.x, cursor, Math.min(inner.width, cross), main),
      );
      if (failure !== null) return failure;
      cursor += main + gap;
    }
    return null;
  };
  const failure = visit(
    snapshot.root,
    rect(0, 0, input.viewport.x, input.viewport.y),
  );
  if (failure !== null) return failure;
  entries.sort((left, right) =>
    left.reading_order - right.reading_order || left.id.localeCompare(right.id)
  );
  input.observer?.event("ui_layout_completed", {
    nodes: entries.length,
    scale: input.player_scale,
  });
  return {
    type: "ready",
    entries: Object.freeze(entries),
    reduced_motion: input.reduced_motion,
  };
}
