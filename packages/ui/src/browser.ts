import type { Observer } from "@ink/observability/observer.ts";
import type { UiEvent } from "./controller.ts";
import type { UiLayoutEntry } from "./layout.ts";
import { type LocalizationResolver, require_ui_text } from "./localization.ts";
import {
  flatten_semantic_tree,
  type SemanticNode,
  type UiId,
  type UiSnapshot,
} from "./semantic.ts";

export interface UiTextureCopyRequest {
  readonly id: UiId;
  readonly element: HTMLElement;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
}

export interface UiTextureCopyBoundary {
  copy(request: UiTextureCopyRequest): boolean;
}

export interface BrowserUiOptions {
  readonly document: Document;
  readonly root: HTMLElement;
  readonly dispatch: (event: UiEvent) => void;
  readonly observer?: Observer;
  readonly texture_copy?: UiTextureCopyBoundary;
}

export type BrowserUiMode = "overlay" | "html_in_canvas";

export class BrowserUiAdapter {
  readonly #options: BrowserUiOptions;
  readonly #elements = new Map<string, HTMLElement>();
  readonly #nodes = new Map<string, SemanticNode>();
  #mode: BrowserUiMode;

  constructor(options: BrowserUiOptions) {
    this.#options = options;
    this.#mode = options.texture_copy === undefined
      ? "overlay"
      : "html_in_canvas";
  }

  mode(): BrowserUiMode {
    return this.#mode;
  }

  update(
    snapshot: UiSnapshot,
    layout: readonly UiLayoutEntry[],
    resolver: LocalizationResolver,
  ): void {
    const nodes = flatten_semantic_tree(snapshot.root);
    const active = new Set<string>(nodes.map(({ id }) => id));
    for (const [id, element] of this.#elements) {
      if (active.has(id)) continue;
      element.remove();
      this.#elements.delete(id);
      this.#nodes.delete(id);
    }
    const rectangles = new Map(layout.map((entry) => [entry.id, entry.rect]));
    for (const node of nodes) {
      let element = this.#elements.get(node.id);
      const expected_tag = tag_for(node);
      if (element?.tagName.toLowerCase() !== expected_tag) {
        element?.remove();
        element = this.#create(node, expected_tag);
        this.#elements.set(node.id, element);
      }
      this.#nodes.set(node.id, node);
      patch_element(element, node, snapshot.direction, resolver);
      const bounds = rectangles.get(node.id);
      if (bounds !== undefined) {
        element.style.position = "absolute";
        element.style.left = `${bounds.x}px`;
        element.style.top = `${bounds.y}px`;
        element.style.width = `${bounds.width}px`;
        element.style.height = `${bounds.height}px`;
      }
    }
    for (const node of nodes) {
      if (!("children" in node)) continue;
      this.#elements.get(node.id)!.replaceChildren(
        ...node.children.filter((child) => !child.hidden).map((child) =>
          this.#elements.get(child.id)!
        ),
      );
    }
    this.#options.root.replaceChildren(this.#elements.get(snapshot.root.id)!);
    if (this.#options.texture_copy === undefined || this.#mode === "overlay") {
      return;
    }
    for (const entry of layout) {
      const element = this.#elements.get(entry.id);
      if (element === undefined) continue;
      try {
        if (
          !this.#options.texture_copy.copy({
            id: entry.id,
            element,
            width: entry.rect.width,
            height: entry.rect.height,
            revision: snapshot.revision,
          })
        ) {
          this.#fallback("texture copy boundary rejected an element");
          return;
        }
      } catch (error) {
        this.#fallback(error instanceof Error ? error.message : String(error));
        return;
      }
    }
  }

  focus(id: UiId): boolean {
    const element = this.#elements.get(id);
    if (element === undefined) return false;
    element.focus();
    return true;
  }

  dispose(): void {
    this.#options.root.replaceChildren();
    this.#elements.clear();
    this.#nodes.clear();
  }

  #create(node: SemanticNode, tag: string): HTMLElement {
    const element = this.#options.document.createElement(tag);
    element.dataset.inkUiId = node.id;
    element.addEventListener(
      "focus",
      () => this.#options.dispatch({ type: "focus_changed", target: node.id }),
    );
    element.addEventListener("click", () => {
      const current = this.#nodes.get(node.id);
      if (current?.role === "button" || current?.role === "toggle") {
        this.#options.dispatch({ type: "activated", target: current.id });
      }
    });
    element.addEventListener("input", () => {
      const current = this.#nodes.get(node.id);
      if (current?.role !== "text_input") return;
      this.#options.dispatch({
        type: "text_edited",
        target: current.id,
        value: (element as HTMLInputElement).value,
      });
    });
    element.addEventListener("change", () => {
      const current = this.#nodes.get(node.id);
      if (current?.role === "slider") {
        this.#options.dispatch({
          type: "value_changed",
          target: current.id,
          value: Number((element as HTMLInputElement).value),
        });
      }
      if (current?.role === "toggle") {
        this.#options.dispatch({
          type: "value_changed",
          target: current.id,
          value: (element as HTMLInputElement).checked,
        });
      }
    });
    return element;
  }

  #fallback(reason: string): void {
    this.#mode = "overlay";
    this.#options.observer?.event("ui_capability_lost", {
      capability: "html_in_canvas",
      reason,
    });
  }
}

function tag_for(node: SemanticNode): string {
  switch (node.role) {
    case "region":
      return "section";
    case "group":
      return "div";
    case "list":
      return "ul";
    case "button":
      return "button";
    case "text":
      return "span";
    case "image":
      return "img";
    case "progress":
      return "progress";
    case "slider":
    case "toggle":
      return "input";
    case "text_input":
      return node.multiline ? "textarea" : "input";
    case "status":
      return "output";
  }
}

function patch_element(
  element: HTMLElement,
  node: SemanticNode,
  direction: UiSnapshot["direction"],
  resolver: LocalizationResolver,
): void {
  const label = require_ui_text(node.label, resolver);
  element.setAttribute("aria-label", label);
  element.dir = direction;
  if (node.description !== undefined) {
    element.setAttribute(
      "aria-description",
      require_ui_text(node.description, resolver),
    );
  } else element.removeAttribute("aria-description");
  if (node.disabled) element.setAttribute("disabled", "");
  else element.removeAttribute("disabled");
  if (node.role !== "image" && node.role !== "text_input") {
    element.textContent = label;
  }
  if (node.role === "button") {
    element.setAttribute("aria-pressed", String(node.pressed ?? false));
    element.setAttribute("aria-selected", String(node.selected ?? false));
  } else if (node.role === "image") {
    element.setAttribute("alt", require_ui_text(node.alternative, resolver));
  } else if (node.role === "progress") {
    Object.assign(element as HTMLProgressElement, {
      min: node.minimum,
      max: node.maximum,
      value: node.value,
    });
  } else if (node.role === "slider") {
    Object.assign(element as HTMLInputElement, {
      type: "range",
      min: String(node.minimum),
      max: String(node.maximum),
      step: String(node.step),
      value: String(node.value),
    });
  } else if (node.role === "toggle") {
    Object.assign(element as HTMLInputElement, {
      type: "checkbox",
      checked: node.checked,
    });
  } else if (node.role === "text_input") {
    if (!node.multiline) {
      (element as HTMLInputElement).type = node.private ? "password" : "text";
    }
    (element as HTMLInputElement | HTMLTextAreaElement).value = node.value;
  } else if (node.role === "status") {
    element.setAttribute("aria-live", node.politeness);
  }
}
