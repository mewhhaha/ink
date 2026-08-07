import type { InputFrame } from "@ink/input/model.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { UiLayoutEntry } from "./layout.ts";
import {
  flatten_semantic_tree,
  node_is_focusable,
  type SemanticNode,
  type UiId,
  type UiSnapshot,
} from "./semantic.ts";

export type NavigationDirection =
  | "next"
  | "previous"
  | "up"
  | "down"
  | "left"
  | "right";

export type UiAction =
  | { readonly type: "focus"; readonly target: UiId }
  | { readonly type: "navigate"; readonly direction: NavigationDirection }
  | { readonly type: "activate"; readonly target?: UiId }
  | {
    readonly type: "change";
    readonly target: UiId;
    readonly value: number | boolean;
  }
  | {
    readonly type: "text_edit";
    readonly target: UiId;
    readonly value: string;
  };

export type UiEvent =
  | { readonly type: "focus_changed"; readonly target: UiId | null }
  | { readonly type: "activated"; readonly target: UiId }
  | {
    readonly type: "value_changed";
    readonly target: UiId;
    readonly value: number | boolean;
  }
  | {
    readonly type: "text_edited";
    readonly target: UiId;
    readonly value: string;
  }
  | {
    readonly type: "announcement";
    readonly target: UiId;
    readonly politeness: "polite" | "assertive";
  };

function child_identities(node: SemanticNode): Set<string> {
  return new Set(flatten_semantic_tree(node).map(({ id }) => id));
}

export class UiController {
  readonly #observer: Observer | undefined;
  #snapshot: UiSnapshot | null = null;
  #layout: readonly UiLayoutEntry[] = [];
  #focus: UiId | null = null;
  #announcements = new Set<string>();

  constructor(observer?: Observer) {
    this.#observer = observer;
  }

  focused(): UiId | null {
    return this.#focus;
  }

  update(
    snapshot: UiSnapshot,
    layout: readonly UiLayoutEntry[],
  ): readonly UiEvent[] {
    this.#snapshot = snapshot;
    this.#layout = layout;
    const events: UiEvent[] = [];
    const focusable = this.#focusable_nodes();
    if (
      this.#focus !== null && !focusable.some((node) => node.id === this.#focus)
    ) {
      this.#focus = focusable[0]?.id ?? null;
      events.push(
        Object.freeze({ type: "focus_changed", target: this.#focus }),
      );
      this.#observe_focus();
    }
    for (const announcement of snapshot.announcements) {
      if (this.#announcements.has(announcement.id)) continue;
      this.#announcements.add(announcement.id);
      events.push(
        Object.freeze({
          type: "announcement",
          target: announcement.id,
          politeness: announcement.politeness,
        }),
      );
      this.#observer?.event("ui_announcement", {
        id: announcement.id,
        politeness: announcement.politeness,
      });
    }
    return Object.freeze(events);
  }

  dispatch(action: UiAction): readonly UiEvent[] {
    if (this.#snapshot === null) return Object.freeze([]);
    switch (action.type) {
      case "focus":
        return this.#set_focus(action.target);
      case "navigate":
        if (
          ![
            "next",
            "previous",
            "up",
            "down",
            "left",
            "right",
          ].includes(action.direction)
        ) return Object.freeze([]);
        return this.#navigate(action.direction);
      case "activate": {
        const target = action.target ?? this.#focus;
        if (target === null) return Object.freeze([]);
        const node = this.#node(target);
        if (node === undefined || !node_is_focusable(node)) {
          return Object.freeze([]);
        }
        if (node.role !== "button" && node.role !== "toggle") {
          return Object.freeze([]);
        }
        this.#observer?.event("ui_action_dispatched", {
          type: "activate",
          target,
        });
        return Object.freeze([Object.freeze({ type: "activated", target })]);
      }
      case "change": {
        const node = this.#node(action.target);
        if (node === undefined || node.disabled) return Object.freeze([]);
        let value = action.value;
        if (
          node.role === "slider" && typeof value === "number" &&
          Number.isFinite(value)
        ) {
          value = Math.min(
            node.maximum,
            Math.max(
              node.minimum,
              Math.round((value - node.minimum) / node.step) * node.step +
                node.minimum,
            ),
          );
        } else if (node.role !== "toggle" || typeof value !== "boolean") {
          return Object.freeze([]);
        }
        this.#observer?.event("ui_action_dispatched", {
          type: "change",
          target: action.target,
          value,
        });
        return Object.freeze([
          Object.freeze({
            type: "value_changed",
            target: action.target,
            value,
          }),
        ]);
      }
      case "text_edit": {
        const node = this.#node(action.target);
        if (
          node?.role !== "text_input" || node.disabled ||
          typeof action.value !== "string"
        ) {
          return Object.freeze([]);
        }
        this.#observer?.event("ui_action_dispatched", {
          type: "text_edit",
          target: action.target,
          length: action.value.length,
        });
        return Object.freeze([
          Object.freeze({
            type: "text_edited",
            target: action.target,
            value: action.value,
          }),
        ]);
      }
    }
  }

  #node(id: UiId): SemanticNode | undefined {
    return this.#snapshot === null
      ? undefined
      : flatten_semantic_tree(this.#snapshot.root).find((node) =>
        node.id === id
      );
  }

  #focusable_nodes(): readonly SemanticNode[] {
    if (this.#snapshot === null) return [];
    let nodes = flatten_semantic_tree(this.#snapshot.root);
    const modal = [...nodes].reverse().find((node) =>
      node.role === "region" && node.modal
    );
    if (modal !== undefined) {
      const contained = child_identities(modal);
      nodes = nodes.filter((node) => contained.has(node.id));
    }
    const focus_order = new Map(
      this.#layout.map((entry) => [entry.id, entry.focus_order]),
    );
    return nodes.filter(node_is_focusable).sort((left, right) =>
      (focus_order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (focus_order.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id)
    );
  }

  #set_focus(target: UiId): readonly UiEvent[] {
    if (
      !this.#focusable_nodes().some((node) => node.id === target) ||
      this.#focus === target
    ) return Object.freeze([]);
    this.#focus = target;
    this.#observe_focus();
    return Object.freeze([Object.freeze({ type: "focus_changed", target })]);
  }

  #navigate(direction: NavigationDirection): readonly UiEvent[] {
    const nodes = this.#focusable_nodes();
    if (nodes.length === 0) return Object.freeze([]);
    const current_index = nodes.findIndex((node) => node.id === this.#focus);
    if (direction === "next" || direction === "previous" || current_index < 0) {
      const delta = direction === "previous" ? -1 : 1;
      const index = current_index < 0
        ? (delta > 0 ? 0 : nodes.length - 1)
        : (current_index + delta + nodes.length) % nodes.length;
      return this.#set_focus(nodes[index].id);
    }
    const current = this.#layout.find((entry) => entry.id === this.#focus);
    if (current === undefined) return Object.freeze([]);
    const center_x = current.rect.x + current.rect.width / 2;
    const center_y = current.rect.y + current.rect.height / 2;
    const candidates = nodes.flatMap((node) => {
      const entry = this.#layout.find((candidate) => candidate.id === node.id);
      if (entry === undefined || entry.id === current.id) return [];
      const x = entry.rect.x + entry.rect.width / 2 - center_x;
      const y = entry.rect.y + entry.rect.height / 2 - center_y;
      const eligible = direction === "left"
        ? x < 0
        : direction === "right"
        ? x > 0
        : direction === "up"
        ? y < 0
        : y > 0;
      return eligible ? [{ node, distance: x * x + y * y }] : [];
    }).sort((left, right) =>
      left.distance - right.distance ||
      left.node.id.localeCompare(right.node.id)
    );
    return candidates.length === 0
      ? Object.freeze([])
      : this.#set_focus(candidates[0].node.id);
  }

  #observe_focus(): void {
    this.#observer?.event("ui_focus_changed", { target: this.#focus });
  }
}

export function ui_actions_from_input_frame(
  frame: InputFrame,
): readonly UiAction[] {
  const actions: UiAction[] = [];
  const mappings: readonly [string, NavigationDirection][] = [
    ["ui.next", "next"],
    ["ui.previous", "previous"],
    ["ui.up", "up"],
    ["ui.down", "down"],
    ["ui.left", "left"],
    ["ui.right", "right"],
  ];
  for (const [id, direction] of mappings) {
    const value = frame.actions.find((action) => action.id === id)?.value;
    if (value?.type === "digital" && value.phase === "pressed") {
      actions.push(Object.freeze({ type: "navigate", direction }));
    }
  }
  const activation = frame.actions.find((action) => action.id === "ui.activate")
    ?.value;
  if (activation?.type === "digital" && activation.phase === "pressed") {
    actions.push(Object.freeze({ type: "activate" }));
  }
  return Object.freeze(actions);
}
