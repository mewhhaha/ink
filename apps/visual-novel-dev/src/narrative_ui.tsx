import {
  game_action_from_ui_event,
  type GameAction,
} from "@ink/blot/protocol.ts";
import type { BlotPresentation } from "@ink/blot/runtime.ts";
import { vec2 } from "@ink/math/vector.ts";
import { BrowserUiAdapter } from "@ink/ui/browser.ts";
import { layout_ui } from "@ink/ui/layout.ts";
import type { LocalizationResolver } from "@ink/ui/localization.ts";
import { useEffect, useRef } from "react";

const literal_resolver: LocalizationResolver = {
  resolve(id) {
    throw new Error(
      `narrative UI unexpectedly requested localization message ${
        JSON.stringify(id)
      }`,
    );
  },
};

export interface NarrativeUiProps {
  readonly presentation: BlotPresentation;
  readonly dispatch_action: (action: GameAction) => Promise<void>;
}

export function NarrativeUi(
  { presentation, dispatch_action }: NarrativeUiProps,
) {
  const root_reference = useRef<HTMLDivElement>(null);
  const dispatch_reference = useRef(dispatch_action);
  dispatch_reference.current = dispatch_action;

  useEffect(() => {
    const root = root_reference.current;
    if (root === null) return;
    const adapter = new BrowserUiAdapter({
      document,
      root,
      dispatch(event) {
        if (event.type !== "activated") return;
        const action = game_action_from_ui_event(
          presentation.observation,
          event,
        );
        if (action !== undefined) void dispatch_reference.current(action);
      },
    });
    const update = () => {
      const bounds = root.getBoundingClientRect();
      const player_scale = Math.max(
        0.5,
        Math.min(1, bounds.width / 960),
      );
      root.style.setProperty(
        "--narrative-player-scale",
        String(player_scale),
      );
      const layout = layout_ui(presentation.observation.ui, {
        viewport: vec2(
          Math.max(1, bounds.width),
          Math.max(1, bounds.height),
        ),
        player_scale,
        reduced_motion: globalThis.matchMedia?.(
          "(prefers-reduced-motion: reduce)",
        ).matches ?? false,
      });
      if (layout.type === "rejected") {
        throw new Error(
          `narrative UI node ${
            JSON.stringify(layout.node)
          } could not be laid out: ${layout.reason}`,
        );
      }
      adapter.update(
        presentation.observation.ui,
        layout.entries,
        literal_resolver,
      );
    };
    const resize = new ResizeObserver(update);
    resize.observe(root);
    update();
    return () => {
      resize.disconnect();
      adapter.dispose();
      root.style.removeProperty("--narrative-player-scale");
    };
  }, [presentation]);

  return (
    <div
      ref={root_reference}
      className="narrative-ui"
      aria-label="Story dialogue and choices"
    />
  );
}
