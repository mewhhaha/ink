import { srgb_rgba } from "./color.ts";
import {
  canonical_material_record,
  create_material_definition,
  default_pbr_parameters,
  material_feature_key,
  serialize_canonical_material,
} from "./canonical.ts";
import { material_definition_id, material_instance_id } from "./identity.ts";
import { import_metallic_roughness } from "./experimental/import.ts";
import { MaterialLibrary } from "./experimental/library.ts";
import type { MaterialFeature } from "./model.ts";

const definition = create_material_definition({
  id: material_definition_id("benchmark.surface"),
  revision: 1,
  parameters: {
    ...default_pbr_parameters(),
    clearcoat: 0.5,
    transmission: 0.25,
    thickness: 0.1,
  },
  alpha: { type: "opaque" },
  sidedness: "double",
});
const canonical = canonical_material_record(definition);
const canonical_bytes = new TextEncoder().encode(
  serialize_canonical_material(canonical),
).length;

Deno.bench(
  `create canonical record (${canonical_bytes} serialized bytes)`,
  () => {
    canonical_material_record(definition);
  },
);

const library = new MaterialLibrary();
library.publish(definition);
const instance = library.create_instance({
  id: material_instance_id("benchmark.instance"),
  definition: definition.id,
});
let roughness_tick = 0;

Deno.bench("update one retained material instance", () => {
  roughness_tick = (roughness_tick + 1) % 101;
  library.update_instance(instance.id, {
    overrides: { perceptual_roughness: roughness_tick / 100 },
  });
});

Deno.bench("import one metallic-roughness material", () => {
  import_metallic_roughness({
    id: material_definition_id("benchmark.import"),
    revision: 1,
    base_color: srgb_rgba(0.7, 0.4, 0.2, 1),
    metallic: 0.65,
    perceptual_roughness: 0.3,
  });
});

const features: readonly MaterialFeature[] = [
  "alpha_mask",
  "alpha_blend",
  "double_sided",
  "normal_map",
  "occlusion",
  "emissive",
  "clearcoat",
  "transmission",
  "volume",
  "toon",
  "unlit",
];

Deno.bench("enumerate 2,048 feature keys", () => {
  const keys = new Set<string>();
  for (let mask = 0; mask < 2 ** features.length; mask += 1) {
    const selected = features.filter((_, index) => (mask & (1 << index)) !== 0);
    keys.add(material_feature_key(selected));
  }
  if (keys.size !== 2 ** features.length) {
    throw new Error(`feature key cardinality was ${keys.size}, expected 2,048`);
  }
});
