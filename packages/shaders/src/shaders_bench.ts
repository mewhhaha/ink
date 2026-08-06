import { reusable_wgsl_modules } from "./builtins.ts";
import { compose_wgsl_modules } from "./compose.ts";
import { resolve_shader_variant } from "./variant.ts";

Deno.bench("compose all reusable WGSL modules", () => {
  compose_wgsl_modules(
    reusable_wgsl_modules.map(({ id }) => id),
    reusable_wgsl_modules,
  );
});

Deno.bench("resolve a four-field shader variant", () => {
  resolve_shader_variant({
    id: "benchmark",
    fields: [
      { name: "alpha", type: "boolean", default_value: false },
      {
        name: "lights",
        type: "integer",
        minimum: 0,
        maximum: 256,
        default_value: 64,
      },
      {
        name: "roughness",
        type: "number",
        minimum: 0,
        maximum: 1,
        default_value: 0.5,
      },
      {
        name: "path",
        type: "enum",
        values: ["compatibility", "clustered_forward", "deferred"],
        default_value: "clustered_forward",
      },
    ],
  }, { alpha: true, lights: 128, roughness: 0.25, path: "deferred" });
});
