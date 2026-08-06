import { vec2 } from "@ink/math/vector.ts";
import { headless_ui_snapshot } from "./headless.ts";
import { layout_ui } from "./layout.ts";
import {
  literal_text,
  type SemanticNode,
  ui_id,
  type UiSnapshot,
} from "./semantic.ts";

const children: SemanticNode[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: ui_id(`benchmark.button.${index}`),
  role: "button" as const,
  label: literal_text(`Button ${index}`),
  size: { height: 24, grow: 1 },
}));
const benchmark_snapshot: UiSnapshot = {
  revision: 1,
  direction: "ltr",
  root: {
    id: ui_id("benchmark.root"),
    role: "region",
    label: literal_text("Benchmark"),
    layout: { type: "flex", direction: "column", gap: 1, padding: 4 },
    children,
  },
  announcements: [],
};
const benchmark_layout = layout_ui(benchmark_snapshot, {
  viewport: vec2(1920, 1080),
  player_scale: 1,
  reduced_motion: false,
});
if (benchmark_layout.type !== "ready") throw new Error(benchmark_layout.reason);
const resolver = { resolve: (message: string) => message };

Deno.bench("layout 1,000 retained UI nodes", () => {
  const result = layout_ui(benchmark_snapshot, {
    viewport: vec2(1920, 1080),
    player_scale: 1,
    reduced_motion: false,
  });
  if (result.type !== "ready" || result.entries.length !== 1_001) {
    throw new Error("UI layout benchmark produced an incomplete result");
  }
});

Deno.bench("project 1,000 nodes to headless semantics", () => {
  const result = headless_ui_snapshot(
    benchmark_snapshot,
    benchmark_layout.entries,
    resolver,
  );
  if (result.nodes.length !== 1_001) {
    throw new Error(
      `headless UI benchmark produced ${result.nodes.length} nodes`,
    );
  }
});
