import type { GameAction, SemanticRegion } from "@ink/engine/protocol.ts";
import type { DetailedHTMLProps, HTMLAttributes } from "react";
import { wheel_zoom_action } from "./logic.ts";

export type SemanticInteraction = "activate" | "paint";

interface SemanticEntry {
  readonly element: HTMLElement;
  region: SemanticRegion;
}

const game_surface_name = "ink-game-surface";

export class InkGameSurfaceElement extends HTMLElement {
  readonly canvas: HTMLCanvasElement;
  readonly #entries = new Map<string, SemanticEntry>();
  #dispatch_game_action: (action: GameAction) => Promise<void> = async () => {};
  #gameplay_enabled = false;
  #painting_pointer: number | null = null;
  #semantic_interaction: SemanticInteraction = "activate";
  #structure_fingerprint = "";
  #wheel_delta_y = 0;
  #zoom_frame: number | undefined;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        display: block;
      }

      canvas {
        display: block;
        width: 100%;
        height: 100%;
      }

      .canvas-semantic-region {
        position: absolute;
        top: 0;
        left: 0;
        box-sizing: border-box;
        border-style: solid;
        margin: 0;
        transform-origin: top left;
      }

      button.canvas-semantic-region:not(:disabled) {
        cursor: pointer;
      }
    `;
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("layoutsubtree", "");
    this.canvas.addEventListener("wheel", this.#zoom_camera, {
      passive: false,
    });
    shadow.append(style, this.canvas);
  }

  connectedCallback() {
    globalThis.addEventListener("pointerup", this.#finish_painting);
    globalThis.addEventListener("pointercancel", this.#finish_painting);
  }

  disconnectedCallback() {
    globalThis.removeEventListener("pointerup", this.#finish_painting);
    globalThis.removeEventListener("pointercancel", this.#finish_painting);
    this.#painting_pointer = null;
    this.#wheel_delta_y = 0;
    if (this.#zoom_frame !== undefined) {
      cancelAnimationFrame(this.#zoom_frame);
      this.#zoom_frame = undefined;
    }
  }

  update_semantics(
    regions: readonly SemanticRegion[],
    dispatch_game_action: (action: GameAction) => Promise<void>,
    semantic_interaction: SemanticInteraction,
  ) {
    this.#dispatch_game_action = dispatch_game_action;
    this.#semantic_interaction = semantic_interaction;

    const active_ids = new Set(regions.map((region) => region.id));
    for (const [id, entry] of this.#entries) {
      if (active_ids.has(id)) continue;
      entry.element.remove();
      this.#entries.delete(id);
    }

    for (const region of regions) {
      const current = this.#entries.get(region.id);
      if (current?.region.role === region.role) {
        this.#patch_element(current.element, current.region, region);
        current.region = region;
        continue;
      }
      current?.element.remove();
      const element = this.#create_element(region);
      this.#patch_element(element, undefined, region);
      this.#entries.set(region.id, { element, region });
    }

    const structure_fingerprint = JSON.stringify(
      regions.map((region) => [region.id, region.role]),
    );
    if (structure_fingerprint === this.#structure_fingerprint) return;
    this.#structure_fingerprint = structure_fingerprint;
    this.canvas.append(
      ...regions.map((region) => this.#entries.get(region.id)!.element),
    );
  }

  set_gameplay_enabled(enabled: boolean) {
    this.#gameplay_enabled = enabled;
    for (const entry of this.#entries.values()) {
      if (entry.element instanceof HTMLButtonElement) {
        entry.element.disabled = !enabled;
      }
    }
  }

  #create_element(region: SemanticRegion): HTMLElement {
    let element: HTMLElement;
    switch (region.role) {
      case "button": {
        const button = document.createElement("button");
        button.type = "button";
        button.disabled = !this.#gameplay_enabled;
        button.addEventListener("focus", () => {
          const current = this.#entries.get(region.id)?.region;
          if (current?.role !== "button") return;
          void this.#dispatch_game_action({
            type: "focus",
            target: current.target,
          });
        });
        button.addEventListener("pointerdown", (event) => {
          if (this.#semantic_interaction !== "paint" || event.button !== 0) {
            return;
          }
          const current = this.#entries.get(region.id)?.region;
          if (current?.role !== "button") return;
          event.preventDefault();
          this.#painting_pointer = event.pointerId;
          button.focus();
          void this.#dispatch_game_action({
            type: "activate",
            target: current.target,
          });
        });
        button.addEventListener("pointerenter", (event) => {
          if (
            this.#semantic_interaction !== "paint" ||
            this.#painting_pointer !== event.pointerId ||
            (event.buttons & 1) === 0
          ) return;
          const current = this.#entries.get(region.id)?.region;
          if (current?.role !== "button") return;
          button.focus();
          void this.#dispatch_game_action({
            type: "activate",
            target: current.target,
          });
        });
        button.addEventListener("click", (event) => {
          if (this.#semantic_interaction === "paint" && event.detail !== 0) {
            return;
          }
          const current = this.#entries.get(region.id)?.region;
          if (current?.role !== "button") return;
          void this.#dispatch_game_action({
            type: "activate",
            target: current.target,
          });
        });
        element = button;
        break;
      }
      case "text":
        element = document.createElement("span");
        break;
      case "progress":
        element = document.createElement("progress");
        break;
    }
    element.className = "canvas-semantic-region";
    element.dataset.inkSemanticId = region.id;
    return element;
  }

  #patch_element(
    element: HTMLElement,
    previous: SemanticRegion | undefined,
    region: SemanticRegion,
  ) {
    if (previous?.label !== region.label) {
      element.setAttribute("aria-label", region.label);
      if (region.role !== "progress") element.textContent = region.label;
    }
    if (previous?.description !== region.description) {
      element.setAttribute("aria-description", region.description);
    }
    if (previous?.element_size.width !== region.element_size.width) {
      element.style.width = `${region.element_size.width}px`;
    }
    if (previous?.element_size.height !== region.element_size.height) {
      element.style.height = `${region.element_size.height}px`;
    }
    if (previous?.style.background_color !== region.style.background_color) {
      element.style.backgroundColor = region.style.background_color;
    }
    if (previous?.style.border_color !== region.style.border_color) {
      element.style.borderColor = region.style.border_color;
    }
    if (previous?.style.border_radius !== region.style.border_radius) {
      element.style.borderRadius = `${region.style.border_radius}px`;
    }
    if (previous?.style.border_width !== region.style.border_width) {
      element.style.borderWidth = `${region.style.border_width}px`;
    }
    if (previous?.style.color !== region.style.color) {
      element.style.color = region.style.color;
    }
    if (previous?.style.font_size !== region.style.font_size) {
      element.style.fontSize = `${region.style.font_size}px`;
    }
    if (previous?.style.font_weight !== region.style.font_weight) {
      element.style.fontWeight = `${region.style.font_weight}`;
    }

    if (region.role === "button") {
      const previous_button = previous?.role === "button"
        ? previous
        : undefined;
      if (previous_button?.pressed !== region.pressed) {
        element.setAttribute("aria-pressed", `${region.pressed}`);
      }
      if (previous_button?.selected !== region.selected) {
        if (region.selected) element.dataset.selected = "true";
        else delete element.dataset.selected;
      }
    }
    if (region.role === "progress") {
      const progress = element as HTMLProgressElement;
      const previous_progress = previous?.role === "progress"
        ? previous
        : undefined;
      if (previous_progress?.maximum !== region.maximum) {
        progress.max = region.maximum;
      }
      if (previous_progress?.value !== region.value) {
        progress.value = region.value;
      }
    }
  }

  readonly #finish_painting = () => {
    this.#painting_pointer = null;
  };

  readonly #zoom_camera = (event: WheelEvent) => {
    if (!wheel_zoom_action(event.deltaY)) return;
    event.preventDefault();
    this.#wheel_delta_y += event.deltaY;
    if (this.#zoom_frame !== undefined) return;
    this.#zoom_frame = requestAnimationFrame(() => {
      this.#zoom_frame = undefined;
      const action = wheel_zoom_action(this.#wheel_delta_y);
      this.#wheel_delta_y = 0;
      if (action) void this.#dispatch_game_action(action);
    });
  };
}

if (!customElements.get(game_surface_name)) {
  customElements.define(game_surface_name, InkGameSurfaceElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "ink-game-surface": InkGameSurfaceElement;
  }
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ink-game-surface": DetailedHTMLProps<
        HTMLAttributes<InkGameSurfaceElement>,
        InkGameSurfaceElement
      >;
    }
  }
}
