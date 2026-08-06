import type { AssetId } from "@ink/assets/identity.ts";
import type { Observer } from "@ink/observability/observer.ts";
import {
  type Vec2,
  vec2,
  type Vec3,
  vec3,
  vec3_normalize,
} from "@ink/math/vector.ts";

export type TextureSemantic =
  | "base_color"
  | "metallic_roughness"
  | "specular"
  | "normal"
  | "occlusion"
  | "emissive"
  | "clearcoat"
  | "clearcoat_roughness"
  | "transmission"
  | "thickness";
export type TextureColorSpace = "linear" | "srgb";
export type TextureChannel = "r" | "g" | "b" | "a";
export type TextureWrap = "repeat" | "clamp_to_edge" | "mirrored_repeat";
export type TextureFilter = "nearest" | "linear";

export interface TextureSampler {
  readonly minification: TextureFilter;
  readonly magnification: TextureFilter;
  readonly mipmap: TextureFilter;
  readonly wrap_u: TextureWrap;
  readonly wrap_v: TextureWrap;
  readonly anisotropy: 1 | 2 | 4 | 8 | 16;
}

export interface TextureTransform {
  readonly offset: Vec2;
  readonly scale: Vec2;
  readonly rotation_radians: number;
}

export interface TextureBindingInput {
  readonly semantic: TextureSemantic;
  readonly texture: AssetId<"texture">;
  readonly color_space: TextureColorSpace;
  readonly uv_set: number;
  readonly transform?: TextureTransform;
  readonly channels: readonly TextureChannel[];
  readonly sampler?: TextureSampler;
  readonly fallback: readonly number[];
  readonly normal_y?: "up" | "down";
}

export interface TextureBinding extends TextureBindingInput {
  readonly transform: TextureTransform;
  readonly sampler: TextureSampler;
}

export type ResolvedTextureBinding =
  | { readonly type: "texture"; readonly binding: TextureBinding }
  | {
    readonly type: "fallback";
    readonly semantic: TextureSemantic;
    readonly value: readonly number[];
    readonly missing: AssetId<"texture">;
  };

const channel_counts: Readonly<Record<TextureSemantic, number>> = {
  base_color: 4,
  metallic_roughness: 2,
  specular: 3,
  normal: 3,
  occlusion: 1,
  emissive: 3,
  clearcoat: 1,
  clearcoat_roughness: 1,
  transmission: 1,
  thickness: 1,
};

const srgb_semantics = new Set<TextureSemantic>([
  "base_color",
  "specular",
  "emissive",
]);

const default_transform: TextureTransform = Object.freeze({
  offset: vec2(0, 0),
  scale: vec2(1, 1),
  rotation_radians: 0,
});

const default_sampler: TextureSampler = Object.freeze({
  minification: "linear",
  magnification: "linear",
  mipmap: "linear",
  wrap_u: "repeat",
  wrap_v: "repeat",
  anisotropy: 1,
});

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} ${String(value)} must be finite`);
  }
}

export function texture_binding(input: TextureBindingInput): TextureBinding {
  if (!Object.hasOwn(channel_counts, input.semantic)) {
    throw new Error(
      `texture semantic ${JSON.stringify(input.semantic)} is unsupported`,
    );
  }
  const expected_color_space = srgb_semantics.has(input.semantic)
    ? "srgb"
    : "linear";
  if (input.color_space !== expected_color_space) {
    throw new Error(
      `${input.semantic} texture ${
        JSON.stringify(input.texture)
      } must use ${expected_color_space} color space, received ${input.color_space}`,
    );
  }
  if (
    !Number.isSafeInteger(input.uv_set) || input.uv_set < 0 || input.uv_set > 3
  ) {
    throw new Error(
      `${input.semantic} texture ${
        JSON.stringify(input.texture)
      } UV set ${input.uv_set} must be an integer within [0, 3]`,
    );
  }
  const channel_count = channel_counts[input.semantic];
  if (input.channels.length !== channel_count) {
    throw new Error(
      `${input.semantic} texture ${
        JSON.stringify(input.texture)
      } needs ${channel_count} channels, received ${input.channels.length}`,
    );
  }
  if (new Set(input.channels).size !== input.channels.length) {
    throw new Error(
      `${input.semantic} texture ${
        JSON.stringify(input.texture)
      } repeats a channel in ${input.channels.join(",")}`,
    );
  }
  if (input.fallback.length !== channel_count) {
    throw new Error(
      `${input.semantic} texture ${
        JSON.stringify(input.texture)
      } fallback needs ${channel_count} values, received ${input.fallback.length}`,
    );
  }
  input.fallback.forEach((value, index) => {
    finite(value, `${input.semantic} fallback ${index}`);
    if (input.semantic !== "normal" && (value < 0 || value > 1)) {
      throw new Error(
        `${input.semantic} texture ${
          JSON.stringify(input.texture)
        } fallback ${index} value ${value} must be within [0, 1]`,
      );
    }
    if (input.semantic === "normal" && (value < -1 || value > 1)) {
      throw new Error(
        `normal texture ${
          JSON.stringify(input.texture)
        } fallback ${index} value ${value} must be within [-1, 1]`,
      );
    }
  });
  if (input.semantic === "normal" && input.normal_y === undefined) {
    throw new Error(
      `normal texture ${
        JSON.stringify(input.texture)
      } must declare whether its tangent-space Y axis points up or down`,
    );
  }
  if (input.semantic !== "normal" && input.normal_y !== undefined) {
    throw new Error(
      `${input.semantic} texture ${
        JSON.stringify(input.texture)
      } cannot declare normal orientation`,
    );
  }
  const sampler = input.sampler ?? default_sampler;
  if (
    !["nearest", "linear"].includes(sampler.minification) ||
    !["nearest", "linear"].includes(sampler.magnification) ||
    !["nearest", "linear"].includes(sampler.mipmap)
  ) {
    throw new Error(
      `${input.semantic} texture ${
        JSON.stringify(input.texture)
      } sampler filters must be nearest or linear`,
    );
  }
  if (
    !["repeat", "clamp_to_edge", "mirrored_repeat"].includes(sampler.wrap_u) ||
    !["repeat", "clamp_to_edge", "mirrored_repeat"].includes(sampler.wrap_v)
  ) {
    throw new Error(
      `${input.semantic} texture ${
        JSON.stringify(input.texture)
      } sampler wrap modes are unsupported`,
    );
  }
  if (![1, 2, 4, 8, 16].includes(sampler.anisotropy)) {
    throw new Error(
      `${input.semantic} texture ${
        JSON.stringify(input.texture)
      } anisotropy ${sampler.anisotropy} must be 1, 2, 4, 8, or 16`,
    );
  }
  const transform = input.transform ?? default_transform;
  finite(transform.offset.x, `${input.semantic} texture offset x`);
  finite(transform.offset.y, `${input.semantic} texture offset y`);
  finite(transform.scale.x, `${input.semantic} texture scale x`);
  finite(transform.scale.y, `${input.semantic} texture scale y`);
  finite(transform.rotation_radians, `${input.semantic} texture rotation`);
  if (transform.scale.x === 0 || transform.scale.y === 0) {
    throw new Error(
      `${input.semantic} texture ${
        JSON.stringify(input.texture)
      } transform scale cannot contain zero`,
    );
  }
  return Object.freeze({
    ...input,
    channels: Object.freeze([...input.channels]),
    fallback: Object.freeze([...input.fallback]),
    transform: Object.freeze({
      offset: vec2(transform.offset.x, transform.offset.y),
      scale: vec2(transform.scale.x, transform.scale.y),
      rotation_radians: transform.rotation_radians,
    }),
    sampler: Object.freeze({ ...sampler }),
  });
}

export function resolve_texture_bindings(
  bindings: readonly TextureBinding[],
  available: ReadonlySet<AssetId<"texture">>,
  observer?: Observer,
): readonly ResolvedTextureBinding[] {
  return Object.freeze(bindings.map((binding) => {
    if (available.has(binding.texture)) {
      return Object.freeze({ type: "texture", binding });
    }
    observer?.event("material.texture.fallback", {
      semantic: binding.semantic,
      texture_id: binding.texture,
    });
    return Object.freeze({
      type: "fallback",
      semantic: binding.semantic,
      value: binding.fallback,
      missing: binding.texture,
    });
  }));
}

export function orient_tangent_normal(
  sampled: Vec3,
  orientation: "up" | "down",
): Vec3 {
  return vec3_normalize(vec3(
    sampled.x,
    orientation === "down" ? -sampled.y : sampled.y,
    sampled.z,
  ));
}
