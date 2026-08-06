import type { AssetId } from "@ink/assets/identity.ts";
import type { Vec2, Vec3 } from "@ink/math/vector.ts";
import type { SceneNodeId } from "@ink/scene/identity.ts";

declare const ui_id_brand: unique symbol;
export type UiId = string & { readonly [ui_id_brand]: true };

export type TextDirection = "ltr" | "rtl" | "auto";
export type MessageParameter = string | number | boolean;
export type UiText =
  | { readonly type: "literal"; readonly value: string }
  | {
    readonly type: "message";
    readonly id: string;
    readonly parameters: Readonly<Record<string, MessageParameter>>;
  };

export interface UiSize {
  readonly width?: number;
  readonly height?: number;
  readonly grow?: number;
}

export interface UiActionReference {
  readonly id: string;
  readonly label: UiText;
}

export type UiPlacement =
  | { readonly type: "flow" }
  | {
    readonly type: "absolute";
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }
  | {
    readonly type: "viewport";
    readonly anchor:
      | "top_left"
      | "top_right"
      | "bottom_left"
      | "bottom_right"
      | "center";
    readonly inset: Vec2;
    readonly size: Vec2;
  }
  | {
    readonly type: "scene";
    readonly node: SceneNodeId;
    readonly offset: Vec3;
    readonly size: Vec2;
  };

export type ContainerLayout =
  | {
    readonly type: "flex";
    readonly direction: "row" | "column";
    readonly gap: number;
    readonly padding: number;
  }
  | {
    readonly type: "grid";
    readonly columns: number;
    readonly gap: number;
    readonly padding: number;
  }
  | { readonly type: "absolute" };

interface SemanticBase {
  readonly id: UiId;
  readonly label: UiText;
  readonly description?: UiText;
  readonly disabled?: boolean;
  readonly hidden?: boolean;
  readonly reading_order?: number;
  readonly focus_order?: number;
  readonly size?: UiSize;
  readonly placement?: UiPlacement;
  readonly actions?: readonly UiActionReference[];
}

interface ContainerBase extends SemanticBase {
  readonly children: readonly SemanticNode[];
  readonly layout: ContainerLayout;
}

export type SemanticNode =
  | (ContainerBase & { readonly role: "region"; readonly modal?: boolean })
  | (ContainerBase & { readonly role: "group" })
  | (ContainerBase & { readonly role: "list" })
  | (SemanticBase & {
    readonly role: "button";
    readonly pressed?: boolean;
    readonly selected?: boolean;
  })
  | (SemanticBase & { readonly role: "text" })
  | (SemanticBase & {
    readonly role: "image";
    readonly asset?: AssetId;
    readonly alternative: UiText;
  })
  | (SemanticBase & {
    readonly role: "progress";
    readonly minimum: number;
    readonly maximum: number;
    readonly value: number;
  })
  | (SemanticBase & {
    readonly role: "slider";
    readonly minimum: number;
    readonly maximum: number;
    readonly value: number;
    readonly step: number;
  })
  | (SemanticBase & { readonly role: "toggle"; readonly checked: boolean })
  | (SemanticBase & {
    readonly role: "text_input";
    readonly value: string;
    readonly private: boolean;
    readonly multiline?: boolean;
  })
  | (SemanticBase & {
    readonly role: "status";
    readonly politeness: "polite" | "assertive";
  });

export interface UiAnnouncement {
  readonly id: UiId;
  readonly message: UiText;
  readonly politeness: "polite" | "assertive";
}

export interface UiSnapshot {
  readonly revision: number;
  readonly direction: TextDirection;
  readonly root: SemanticNode;
  readonly announcements: readonly UiAnnouncement[];
}

export type UiSnapshotResult =
  | { readonly type: "accepted"; readonly snapshot: UiSnapshot }
  | {
    readonly type: "rejected";
    readonly reason: string;
    readonly retained: UiSnapshot | null;
  };

export function ui_id(value: string): UiId {
  const parsed = value.trim();
  if (parsed.length === 0 || !/^[a-zA-Z0-9_.:-]+$/.test(parsed)) {
    throw new Error(
      `UI identity ${JSON.stringify(value)} must be nonempty and stable`,
    );
  }
  return parsed as UiId;
}

export function literal_text(value: string): UiText {
  return Object.freeze({ type: "literal", value });
}

function finite_nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} ${String(value)} must be finite and nonnegative`);
  }
}

function finite_number(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} ${String(value)} must be finite`);
  }
}

function validate_text(text: UiText, label: string): void {
  const text_type = (text as { readonly type: unknown }).type;
  if (text_type !== "literal" && text_type !== "message") {
    throw new Error(
      `${label} type ${JSON.stringify(text_type)} is unsupported`,
    );
  }
  if (text.type === "message" && text.id.trim().length === 0) {
    throw new Error(`${label} message identity must be nonempty`);
  }
}

function validate_node(
  node: SemanticNode,
  identities: Set<string>,
  path: string,
): void {
  if (
    ![
      "region",
      "group",
      "list",
      "button",
      "text",
      "image",
      "progress",
      "slider",
      "toggle",
      "text_input",
      "status",
    ].includes(node.role)
  ) {
    throw new Error(`UI role ${JSON.stringify(node.role)} is unsupported`);
  }
  if (ui_id(node.id) !== node.id) {
    throw new Error(`UI identity ${JSON.stringify(node.id)} must be canonical`);
  }
  if (identities.has(node.id)) {
    throw new Error(
      `semantic tree duplicates UI identity ${
        JSON.stringify(node.id)
      } at ${path}`,
    );
  }
  identities.add(node.id);
  validate_text(node.label, `${node.id} label`);
  if (node.description !== undefined) {
    validate_text(node.description, `${node.id} description`);
  }
  if (node.reading_order !== undefined) {
    finite_number(node.reading_order, `${node.id} reading order`);
  }
  if (node.focus_order !== undefined) {
    finite_number(node.focus_order, `${node.id} focus order`);
  }
  for (const action of node.actions ?? []) {
    if (action.id.trim().length === 0) {
      throw new Error(`${node.id} action identity must be nonempty`);
    }
    validate_text(action.label, `${node.id} action ${action.id} label`);
  }
  if (node.size?.width !== undefined) {
    finite_nonnegative(node.size.width, `${node.id} width`);
  }
  if (node.size?.height !== undefined) {
    finite_nonnegative(node.size.height, `${node.id} height`);
  }
  if (node.size?.grow !== undefined) {
    finite_nonnegative(node.size.grow, `${node.id} grow`);
  }
  if (
    node.placement !== undefined &&
    !["flow", "absolute", "viewport", "scene"].includes(node.placement.type)
  ) {
    throw new Error(
      `${node.id} placement ${
        JSON.stringify(node.placement.type)
      } is unsupported`,
    );
  }
  if (node.placement?.type === "absolute") {
    finite_number(node.placement.x, `${node.id} absolute x`);
    finite_number(node.placement.y, `${node.id} absolute y`);
    finite_nonnegative(node.placement.width, `${node.id} absolute width`);
    finite_nonnegative(node.placement.height, `${node.id} absolute height`);
  } else if (node.placement?.type === "viewport") {
    finite_number(node.placement.inset.x, `${node.id} viewport inset x`);
    finite_number(node.placement.inset.y, `${node.id} viewport inset y`);
    finite_nonnegative(node.placement.size.x, `${node.id} viewport width`);
    finite_nonnegative(node.placement.size.y, `${node.id} viewport height`);
  } else if (node.placement?.type === "scene") {
    finite_number(node.placement.offset.x, `${node.id} scene offset x`);
    finite_number(node.placement.offset.y, `${node.id} scene offset y`);
    finite_number(node.placement.offset.z, `${node.id} scene offset z`);
    finite_nonnegative(node.placement.size.x, `${node.id} scene width`);
    finite_nonnegative(node.placement.size.y, `${node.id} scene height`);
  }
  if (node.role === "progress" || node.role === "slider") {
    if (
      ![node.minimum, node.maximum, node.value].every(Number.isFinite) ||
      node.minimum >= node.maximum || node.value < node.minimum ||
      node.value > node.maximum
    ) {
      throw new Error(
        `${node.role} ${node.id} value ${node.value} must be within [${node.minimum}, ${node.maximum}]`,
      );
    }
  }
  if (
    node.role === "slider" && (!Number.isFinite(node.step) || node.step <= 0)
  ) {
    throw new Error(
      `slider ${node.id} step ${node.step} must be finite and positive`,
    );
  }
  if (node.role === "text_input" && node.private && node.multiline) {
    throw new Error(
      `text input ${node.id} cannot be both private and multiline because browsers provide no native masked multiline control`,
    );
  }
  if (
    node.role === "image" && node.alternative.type === "literal" &&
    node.alternative.value.length === 0
  ) {
    throw new Error(`image ${node.id} requires alternative text`);
  }
  if ("children" in node) {
    if (
      node.layout.type === "grid" &&
      (!Number.isSafeInteger(node.layout.columns) || node.layout.columns <= 0)
    ) {
      throw new Error(
        `grid ${node.id} columns ${node.layout.columns} must be a positive safe integer`,
      );
    }
    if (node.layout.type !== "absolute") {
      finite_nonnegative(node.layout.gap, `${node.id} layout gap`);
      finite_nonnegative(node.layout.padding, `${node.id} layout padding`);
    }
    node.children.forEach((child, index) =>
      validate_node(child, identities, `${path}/${index}`)
    );
  }
}

export class UiSnapshotStore {
  #current: UiSnapshot | null = null;

  current(): UiSnapshot | null {
    return this.#current;
  }

  replace(candidate: UiSnapshot): UiSnapshotResult {
    try {
      if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 0) {
        throw new Error(
          `UI revision ${candidate.revision} must be a nonnegative safe integer`,
        );
      }
      if (
        this.#current !== null && candidate.revision <= this.#current.revision
      ) {
        throw new Error(
          `UI revision ${candidate.revision} must exceed retained revision ${this.#current.revision}`,
        );
      }
      if (!["ltr", "rtl", "auto"].includes(candidate.direction)) {
        throw new Error(
          `UI direction ${
            JSON.stringify(candidate.direction)
          } must be ltr, rtl, or auto`,
        );
      }
      validate_node(candidate.root, new Set(), "root");
      const announcement_ids = new Set<string>();
      for (const announcement of candidate.announcements) {
        if (ui_id(announcement.id) !== announcement.id) {
          throw new Error(
            `announcement identity ${
              JSON.stringify(announcement.id)
            } must be canonical`,
          );
        }
        if (announcement_ids.has(announcement.id)) {
          throw new Error(
            `UI announcements duplicate identity ${announcement.id}`,
          );
        }
        announcement_ids.add(announcement.id);
        validate_text(
          announcement.message,
          `announcement ${announcement.id} message`,
        );
      }
      const snapshot = immutable_snapshot(candidate);
      this.#current = snapshot;
      return { type: "accepted", snapshot };
    } catch (error) {
      return {
        type: "rejected",
        reason: error instanceof Error ? error.message : String(error),
        retained: this.#current,
      };
    }
  }
}

function immutable_snapshot(candidate: UiSnapshot): UiSnapshot {
  const clone = structuredClone(candidate) as UiSnapshot;
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
      return;
    }
    for (const property of Object.values(value)) freeze(property);
    Object.freeze(value);
  };
  freeze(clone);
  return clone;
}

export function flatten_semantic_tree(
  root: SemanticNode,
): readonly SemanticNode[] {
  const flattened: SemanticNode[] = [];
  const visit = (node: SemanticNode) => {
    if (!node.hidden) flattened.push(node);
    if ("children" in node && !node.hidden) node.children.forEach(visit);
  };
  visit(root);
  return Object.freeze(flattened);
}

export function node_is_focusable(node: SemanticNode): boolean {
  return !node.hidden && !node.disabled &&
    ["button", "slider", "toggle", "text_input"].includes(node.role);
}
