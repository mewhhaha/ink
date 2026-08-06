import { type LocalizationResolver, require_ui_text } from "./localization.ts";
import type { UiLayoutEntry } from "./layout.ts";
import {
  flatten_semantic_tree,
  node_is_focusable,
  type SemanticNode,
  type UiSnapshot,
} from "./semantic.ts";

export interface HeadlessUiNode {
  readonly id: string;
  readonly role: SemanticNode["role"];
  readonly label: string;
  readonly description: string | null;
  readonly disabled: boolean;
  readonly focusable: boolean;
  readonly state: Readonly<Record<string, string | number | boolean>>;
  readonly rect: UiLayoutEntry["rect"] | null;
  readonly actions: readonly { readonly id: string; readonly label: string }[];
}

export interface HeadlessUiSnapshot {
  readonly revision: number;
  readonly direction: UiSnapshot["direction"];
  readonly nodes: readonly HeadlessUiNode[];
  readonly announcements: readonly {
    id: string;
    message: string;
    politeness: "polite" | "assertive";
  }[];
}

function widget_state(
  node: SemanticNode,
): Readonly<Record<string, string | number | boolean>> {
  switch (node.role) {
    case "button":
      return Object.freeze({
        pressed: node.pressed ?? false,
        selected: node.selected ?? false,
      });
    case "progress":
    case "slider":
      return Object.freeze({
        minimum: node.minimum,
        maximum: node.maximum,
        value: node.value,
      });
    case "toggle":
      return Object.freeze({ checked: node.checked });
    case "text_input":
      return Object.freeze({
        value: node.private ? "" : node.value,
        private: node.private,
        multiline: node.multiline ?? false,
      });
    case "status":
      return Object.freeze({ politeness: node.politeness });
    case "image":
      return Object.freeze({
        alternative: "present",
        visual: node.asset === undefined ? "missing" : "available",
      });
    default:
      return Object.freeze({});
  }
}

export function headless_ui_snapshot(
  snapshot: UiSnapshot,
  layout: readonly UiLayoutEntry[],
  resolver: LocalizationResolver,
): HeadlessUiSnapshot {
  const rectangles = new Map(layout.map((entry) => [entry.id, entry.rect]));
  const nodes = flatten_semantic_tree(snapshot.root).map((node) =>
    Object.freeze({
      id: node.id,
      role: node.role,
      label: require_ui_text(node.label, resolver),
      description: node.description === undefined
        ? null
        : require_ui_text(node.description, resolver),
      disabled: node.disabled ?? false,
      focusable: node_is_focusable(node),
      state: widget_state(node),
      rect: rectangles.get(node.id) ?? null,
      actions: Object.freeze(
        (node.actions ?? []).map((action) =>
          Object.freeze({
            id: action.id,
            label: require_ui_text(action.label, resolver),
          })
        ),
      ),
    })
  );
  return Object.freeze({
    revision: snapshot.revision,
    direction: snapshot.direction,
    nodes: Object.freeze(nodes),
    announcements: Object.freeze(
      snapshot.announcements.map((announcement) =>
        Object.freeze({
          id: announcement.id,
          message: require_ui_text(announcement.message, resolver),
          politeness: announcement.politeness,
        })
      ),
    ),
  });
}

export function serialize_headless_ui(snapshot: HeadlessUiSnapshot): string {
  return JSON.stringify(snapshot);
}
