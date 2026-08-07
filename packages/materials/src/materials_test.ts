import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { asset_id } from "@ink/assets/identity.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import {
  canonical_material_record,
  create_material_definition,
  default_pbr_parameters,
  select_material_variant,
  serialize_canonical_material,
} from "./canonical.ts";
import {
  linear_rgb,
  linear_rgba,
  linear_to_srgb,
  srgb_rgb,
  srgb_rgba,
  srgb_to_linear,
} from "./color.ts";
import { material_definition_id, material_variant_id } from "./identity.ts";
import {
  import_metallic_roughness,
  import_specular_glossiness,
} from "./import.ts";
import type {
  MaterialDefinition,
  MaterialDefinitionInput,
  MaterialFeature,
} from "./model.ts";
import { evaluate_reference_brdf } from "./reference.ts";
import {
  orient_tangent_normal,
  resolve_texture_bindings,
  texture_binding,
} from "./texture.ts";

function definition_input(
  fields: Partial<MaterialDefinitionInput> = {},
): MaterialDefinitionInput {
  return {
    id: material_definition_id("fixture"),
    revision: 0,
    parameters: default_pbr_parameters(),
    alpha: { type: "opaque" },
    sidedness: "front",
    ...fields,
  };
}

Deno.test("sRGB conversion crosses the transfer boundary without changing alpha", () => {
  const linear = srgb_to_linear(srgb_rgba(0.5, 0.25, 1, 0.3));
  assertAlmostEquals(linear.r, 0.21404114048223255, 1e-12);
  assertAlmostEquals(linear.g, 0.05087608817155679, 1e-12);
  assertEquals(linear.a, 0.3);
  const encoded = linear_to_srgb(linear);
  assertAlmostEquals(encoded.r, 0.5, 1e-12);
  assertAlmostEquals(encoded.g, 0.25, 1e-12);
  assertEquals(encoded.a, 0.3);
});

Deno.test("texture bindings enforce color space, channels, typed fallbacks, and normal orientation", () => {
  const normal = texture_binding({
    semantic: "normal",
    texture: asset_id<"texture">("normal.ktx2"),
    color_space: "linear",
    uv_set: 1,
    channels: ["r", "g", "b"],
    fallback: [0, 0, 1],
    normal_y: "down",
  });
  assertEquals(normal.transform.scale, vec2(1, 1));
  assertEquals(
    orient_tangent_normal(vec3(0, 0.6, 0.8), "down"),
    vec3(0, -0.6, 0.8),
  );
  assertThrows(
    () =>
      texture_binding({
        semantic: "base_color",
        texture: asset_id<"texture">("base.ktx2"),
        color_space: "linear",
        uv_set: 0,
        channels: ["r", "g", "b", "a"],
        fallback: [1, 1, 1, 1],
      }),
    Error,
    'base_color texture "base.ktx2" must use srgb color space, received linear',
  );
  assertThrows(
    () =>
      texture_binding({
        semantic: "normal",
        texture: asset_id<"texture">("normal.ktx2"),
        color_space: "linear",
        uv_set: 0,
        channels: ["r", "g", "x"] as never,
        fallback: [0, 0, 1],
        normal_y: "sideways" as never,
      }),
    Error,
    'channel "x" is unsupported',
  );
  assertThrows(
    () => orient_tangent_normal(vec3(0, 0, 1), "sideways" as never),
    Error,
    'orientation "sideways" is unsupported',
  );
  assertThrows(
    () =>
      texture_binding({
        semantic: "normal",
        texture: asset_id<"texture">("zero-normal.ktx2"),
        color_space: "linear",
        uv_set: 0,
        channels: ["r", "g", "b"],
        fallback: [0, 0, 0],
        normal_y: "up",
      }),
    Error,
    "fallback cannot be the zero vector",
  );
});

Deno.test("unavailable textures resolve to their declared semantic fallback", () => {
  const binding = texture_binding({
    semantic: "metallic_roughness",
    texture: asset_id<"texture">("surface.ktx2"),
    color_space: "linear",
    uv_set: 0,
    channels: ["b", "g"],
    fallback: [0, 1],
  });
  assertEquals(resolve_texture_bindings([binding], new Set()), [{
    type: "fallback",
    semantic: "metallic_roughness",
    value: [0, 1],
    missing: asset_id<"texture">("surface.ktx2"),
  }]);
});

Deno.test("material validation names bounded parameters and conflicting features", () => {
  assertThrows(
    () =>
      create_material_definition(definition_input({
        parameters: { ...default_pbr_parameters(), metallic: 1.1 },
      })),
    Error,
    "material fixture metallic 1.1 must be within [0, 1]",
  );
  assertThrows(
    () =>
      create_material_definition(definition_input({
        parameters: {
          ...default_pbr_parameters(),
          transmission: 0.5,
        },
        alpha: { type: "blend" },
      })),
    Error,
    "material fixture cannot combine alpha blend and transmission",
  );
  const definition = create_material_definition(definition_input());
  assertThrows(
    () =>
      canonical_material_record(definition, {
        id: "instance" as never,
        definition: definition.id,
        definition_revision: definition.revision,
        revision: 0,
        overrides: { mystery: 1 } as never,
      }),
    Error,
    'instance override "mystery" is unsupported',
  );
});

Deno.test("metallic-roughness import preserves dielectric F0 and perceptual roughness", () => {
  const imported = import_metallic_roughness({
    id: material_definition_id("paint"),
    revision: 3,
    base_color: srgb_rgba(0.5, 0.5, 0.5, 1),
    metallic: 0,
    perceptual_roughness: 0.25,
  });
  const record = canonical_material_record(imported.definition);
  assertAlmostEquals(record.specular_f0.r, 0.04, 1e-12);
  assertEquals(record.parameters.perceptual_roughness, 0.25);
  assertAlmostEquals(
    record.parameters.base_color.r,
    0.21404114048223255,
    1e-12,
  );
});

Deno.test("metallic surfaces use linear base color as F0", () => {
  const imported = import_metallic_roughness({
    id: material_definition_id("metal"),
    revision: 0,
    base_color: srgb_rgba(0.5, 0.25, 0.1, 1),
    metallic: 1,
    perceptual_roughness: 0.4,
  });
  const record = canonical_material_record(imported.definition);
  assertAlmostEquals(
    record.specular_f0.r,
    record.parameters.base_color.r,
    1e-12,
  );
  assertEquals(record.diffuse_color, linear_rgb(0, 0, 0));
});

Deno.test("specular-glossiness import preserves colored F0 and inverts glossiness", () => {
  const imported = import_specular_glossiness({
    id: material_definition_id("legacy.gloss"),
    revision: 0,
    diffuse: srgb_rgba(0.8, 0.4, 0.2, 1),
    specular: srgb_rgb(0.5, 0.25, 0.1),
    glossiness: 0.8,
  });
  const record = canonical_material_record(imported.definition);
  const expected = srgb_to_linear(srgb_rgb(0.5, 0.25, 0.1));
  assertAlmostEquals(record.specular_f0.r, expected.r, 1e-12);
  assertAlmostEquals(record.specular_f0.g, expected.g, 1e-12);
  assertAlmostEquals(record.specular_f0.b, expected.b, 1e-12);
  assertAlmostEquals(record.parameters.perceptual_roughness, 0.2, 1e-12);
  assertEquals(imported.warnings.length, 1);
});

Deno.test("validated feature variants degrade only along declared subset fallbacks", () => {
  const full = material_variant_id("full");
  const basic = material_variant_id("basic");
  const definition = create_material_definition(definition_input({
    parameters: { ...default_pbr_parameters(), clearcoat: 1 },
    variants: [
      { id: full, fallback: basic, required_features: ["clearcoat"] },
      { id: basic, required_features: [] },
    ],
  }));
  const capabilities = {
    supported_features: new Set<MaterialFeature>(),
  };
  assertEquals(select_material_variant(definition, full, capabilities), {
    id: basic,
    features: [],
    degraded_from: full,
  });
  const record = canonical_material_record(definition, {
    id: "basic-instance" as never,
    definition: definition.id,
    definition_revision: definition.revision,
    revision: 0,
    variant: basic,
    overrides: {},
  });
  assertEquals(record.feature_key, "base");
});

Deno.test("stylized extensions are bounded and cannot alter core transparency behavior", () => {
  const toon = create_material_definition(definition_input({
    stylized: { type: "toon", bands: 4, edge_softness: 0.1, rim_strength: 0.5 },
  }));
  assertEquals(toon.features, ["toon"]);
  assertThrows(
    () =>
      create_material_definition(definition_input({
        parameters: { ...default_pbr_parameters(), transmission: 1 },
        stylized: {
          type: "toon",
          bands: 4,
          edge_softness: 0.1,
          rim_strength: 0.5,
        },
      })),
    Error,
    "material fixture cannot combine toon shading and transmission",
  );
});

Deno.test("reference BRDF and serialization are deterministic renderer-independent records", () => {
  const definition: MaterialDefinition = create_material_definition(
    definition_input({
      parameters: {
        ...default_pbr_parameters(),
        base_color: linear_rgba(0.8, 0.4, 0.2, 1),
        perceptual_roughness: 0.5,
      },
    }),
  );
  const record = canonical_material_record(definition);
  const first = evaluate_reference_brdf(
    record,
    vec3(0, 0, 1),
    vec3(0, 0, 1),
    vec3(0, 0, 1),
  );
  const second = evaluate_reference_brdf(
    record,
    vec3(0, 0, 1),
    vec3(0, 0, 1),
    vec3(0, 0, 1),
  );
  assertEquals(first, second);
  assertEquals(
    evaluate_reference_brdf(
      record,
      vec3(0, 0, 1),
      vec3(0, 0, 1),
      vec3(0, 0, -1),
    ).reflected,
    linear_rgb(0, 0, 0),
  );
  assertEquals(serialize_canonical_material(record), JSON.stringify(record));
});
