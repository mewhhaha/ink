import { RenderGraph } from "./graph.ts";
import {
  render_surface,
  render_surface_id,
  type RenderQualityProfile,
} from "./model.ts";
import { build_rendering_path } from "./paths.ts";
import { PipelineCache } from "./shader.ts";
import { scene_node_id } from "@ink/scene/identity.ts";

const surface = render_surface({
  id: render_surface_id("bench"),
  width: 1920,
  height: 1080,
  format: "bgra8unorm",
  revision: 0,
});
const profile: RenderQualityProfile = {
  path: "clustered_forward",
  hdr_format: "rgba16float",
  depth: "reversed",
  sample_count: 1,
  anti_aliasing: "taa",
  upscaling: { type: "native" },
  bloom: true,
  color_grading: true,
  maximum_lights: 1_024,
  maximum_shadow_lights: 16,
};

Deno.bench("render compiles a 100-pass dependency graph", () => {
  const graph = new RenderGraph();
  for (let index = 0; index < 100; index += 1) {
    graph.resource({
      id: `resource-${index}`,
      lifetime: "transient",
      descriptor: { type: "buffer", size_bytes: 256, usage: 0x80 },
    });
  }
  for (let index = 0; index < 100; index += 1) {
    graph.pass({
      id: `pass-${String(index).padStart(3, "0")}`,
      kind: "compute",
      reads: index === 0
        ? []
        : [{ resource: `resource-${index - 1}`, access: "storage_read" }],
      writes: [{
        resource: `resource-${index}`,
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: index === 0 ? [] : [`pass-${String(index - 1).padStart(3, "0")}`],
    });
  }
  graph.compile();
});

Deno.bench("render plans 10,000 clustered-forward draws", () => {
  const nodes = Array.from(
    { length: 10_000 },
    (_, index) => scene_node_id(index, 0),
  );
  const world = {
    scene_revision: 1,
    visible_revision: 1,
    material_revision: 1,
    light_revision: 1,
    transform_revision: 1,
    renderables: nodes.map((node) => ({ node })),
    lighting: {},
  } as never;
  const packets = nodes.map((object) => ({ object })) as never;
  build_rendering_path(profile, surface, world, packets);
});

Deno.bench("render resolves 2,048 pipeline cache lookups", () => {
  const cache = new PipelineCache<number>(256);
  for (let index = 0; index < 2_048; index += 1) {
    cache.acquire(`pipeline-${index % 256}`, index, () => index);
  }
});
