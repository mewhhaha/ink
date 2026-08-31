import {
  game_action_from_ui_event,
  type GameAction,
  type GameObservation,
} from "@ink/blot/protocol.ts";
import { vec2 } from "@ink/math/vector.ts";
import { BrowserUiAdapter } from "@ink/ui/browser.ts";
import { layout_ui } from "@ink/ui/layout.ts";
import type { LocalizationResolver } from "@ink/ui/localization.ts";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

const game_surface_name = "ink-adventure-surface";

const literal_resolver: LocalizationResolver = {
  resolve(id) {
    throw new Error(
      `Blot UI unexpectedly requested localization message ${
        JSON.stringify(id)
      }`,
    );
  },
};

export class InkGameSurfaceElement extends HTMLElement {
  readonly canvas: HTMLCanvasElement;
  readonly #semantic_layer: HTMLDivElement;
  readonly #ui: BrowserUiAdapter;
  #dispatch_game_action: (action: GameAction) => Promise<void> = async () => {};
  #gameplay_enabled = false;
  #observation: GameObservation | undefined;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        display: block;
        position: relative;
      }

      canvas {
        display: block;
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }

      .semantic-layer {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }

      [data-ink-ui-id] {
        box-sizing: border-box;
        margin: 0;
      }

      button[data-ink-ui-id] {
        pointer-events: auto;
      }

      button[data-ink-ui-id]:not(:disabled) {
        cursor: pointer;
      }
    `;
    this.canvas = document.createElement("canvas");
    this.#semantic_layer = document.createElement("div");
    this.#semantic_layer.className = "semantic-layer";
    this.#ui = new BrowserUiAdapter({
      document,
      root: this.#semantic_layer,
      dispatch: (event) => {
        const observation = this.#observation;
        if (observation === undefined) return;
        if (event.type === "activated" && !this.#gameplay_enabled) return;
        const action = game_action_from_ui_event(observation, event);
        if (action !== undefined) void this.#dispatch_game_action(action);
      },
    });
    shadow.append(style, this.canvas, this.#semantic_layer);
  }

  disconnectedCallback() {
    this.#observation = undefined;
    this.#ui.dispose();
  }

  update_ui(
    observation: GameObservation,
    dispatch_game_action: (action: GameAction) => Promise<void>,
  ) {
    if (typeof dispatch_game_action !== "function") {
      throw new Error("game surface action dispatcher must be a function");
    }
    const width = Math.max(1, this.clientWidth);
    const height = Math.max(1, this.clientHeight);
    const layout = layout_ui(observation.ui, {
      viewport: vec2(width, height),
      player_scale: 1,
      reduced_motion: globalThis.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches ?? false,
      scene: {
        project(_node, offset, size) {
          const projected_width = Math.max(1, size.x / 1_000_000 * 48);
          const projected_height = Math.max(1, size.y / 1_000_000 * 48);
          return {
            x: width / 2 + offset.x / 1_000_000 * 48 - projected_width / 2,
            y: height / 2 - offset.y / 1_000_000 * 48 -
              projected_height / 2,
            width: projected_width,
            height: projected_height,
          };
        },
      },
    });
    if (layout.type === "rejected") {
      throw new Error(
        `game surface could not lay out UI node ${
          JSON.stringify(layout.node)
        }: ${layout.reason}`,
      );
    }
    this.#observation = observation;
    this.#dispatch_game_action = dispatch_game_action;
    this.#ui.update(observation.ui, layout.entries, literal_resolver);
    this.#apply_gameplay_state();
  }

  set_gameplay_enabled(enabled: boolean) {
    if (typeof enabled !== "boolean") {
      throw new Error(
        `gameplay enabled ${JSON.stringify(enabled)} must be boolean`,
      );
    }
    this.#gameplay_enabled = enabled;
    this.#apply_gameplay_state();
  }

  #apply_gameplay_state() {
    for (const button of this.#semantic_layer.querySelectorAll("button")) {
      button.disabled = !this.#gameplay_enabled;
    }
  }
}

if (!customElements.get(game_surface_name)) {
  customElements.define(game_surface_name, InkGameSurfaceElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "ink-adventure-surface": InkGameSurfaceElement;
  }
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ink-adventure-surface": DetailedHTMLProps<
        HTMLAttributes<InkGameSurfaceElement>,
        InkGameSurfaceElement
      >;
    }
  }
}
