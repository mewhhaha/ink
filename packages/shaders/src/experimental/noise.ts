import { noise_wgsl_modules } from "@ink/noise/experimental/wgsl.ts";
import { shader_module_id } from "../identity.ts";
import type { WgslModule } from "../model.ts";
import { create_wgsl_module } from "../module.ts";

const noise_functions = Object.freeze({
  hash: [
    "ink_noise_hash",
    "ink_noise_signed",
    "ink_noise_wrap",
    "ink_noise_fade",
  ],
  value: [
    "ink_value_noise_1d",
    "ink_value_noise_2d",
    "ink_value_noise_3d",
  ],
  gradient: [
    "ink_gradient_noise_1d",
    "ink_gradient_2d",
    "ink_gradient_3d",
    "ink_gradient_noise_2d",
    "ink_gradient_noise_3d",
  ],
  cellular: [
    "ink_cellular_nearest_1d",
    "ink_cellular_nearest_2d",
    "ink_cellular_nearest_3d",
  ],
  fractal: [
    "ink_fbm_gradient_1d",
    "ink_fbm_gradient_2d",
    "ink_fbm_gradient_3d",
    "ink_turbulence_gradient_2d",
    "ink_ridged_gradient_2d",
    "ink_domain_warp_gradient_2d",
    "ink_curl_gradient_2d",
  ],
});

const hash_id = shader_module_id("ink/noise/hash");
const gradient_id = shader_module_id("ink/noise/gradient");

export const noise_shader_modules = Object.freeze(
  noise_wgsl_modules.map((module) =>
    create_wgsl_module({
      id: shader_module_id(`ink/noise/${module.name}`),
      revision: 0,
      dependencies: module.name === "hash" ? [] : module.name === "value"
        ? [{
          module: hash_id,
          symbols: ["ink_noise_fade", "ink_noise_signed", "ink_noise_wrap"],
        }]
        : module.name === "gradient"
        ? [{
          module: hash_id,
          symbols: ["ink_noise_fade", "ink_noise_hash", "ink_noise_wrap"],
        }]
        : module.name === "cellular"
        ? [{
          module: hash_id,
          symbols: ["ink_noise_hash", "ink_noise_wrap"],
        }]
        : [{
          module: hash_id,
          symbols: ["ink_noise_hash"],
        }, {
          module: gradient_id,
          symbols: [
            "ink_gradient_noise_1d",
            "ink_gradient_noise_2d",
            "ink_gradient_noise_3d",
          ],
        }],
      symbols: noise_functions[module.name].map((name) => ({
        name,
        kind: "function",
        exported: true,
      })),
      source: module.source,
    })
  ),
);

export function noise_shader_module(
  name: keyof typeof noise_functions,
): WgslModule {
  return noise_shader_modules.find((module) =>
    module.id === `ink/noise/${name}`
  )!;
}
