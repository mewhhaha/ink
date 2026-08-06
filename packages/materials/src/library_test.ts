import { assertEquals, assertThrows } from "@std/assert";
import {
  create_material_definition,
  default_pbr_parameters,
} from "./canonical.ts";
import {
  material_definition_id,
  material_instance_id,
  material_variant_id,
} from "./identity.ts";
import { MaterialLibrary } from "./library.ts";

function definition(revision: number, include_variants = true) {
  return create_material_definition({
    id: material_definition_id("stone"),
    revision,
    parameters: { ...default_pbr_parameters(), clearcoat: 0.5 },
    alpha: { type: "opaque" },
    sidedness: "front",
    variants: include_variants
      ? [{
        id: material_variant_id("coated"),
        required_features: ["clearcoat"],
      }]
      : [],
  });
}

Deno.test("hot replacement propagates definition revisions to retained instances", () => {
  const library = new MaterialLibrary();
  const initial = definition(1);
  assertEquals(library.publish(initial), {
    type: "published",
    id: initial.id,
  });
  const instance = library.create_instance({
    id: material_instance_id("wall"),
    definition: initial.id,
    variant: material_variant_id("coated"),
    overrides: { perceptual_roughness: 0.7 },
  });
  assertEquals(instance.revision, 0);

  assertEquals(library.replace([definition(2)]), {
    type: "replaced",
    definitions: [initial.id],
    instances: [instance.id],
  });
  assertEquals(library.instance(instance.id)?.definition_revision, 2);
  assertEquals(library.instance(instance.id)?.revision, 1);
  assertEquals(
    library.canonical_record(instance.id).parameters.perceptual_roughness,
    0.7,
  );
});

Deno.test("failed replacement leaves definitions and instance revisions unchanged", () => {
  const library = new MaterialLibrary();
  const initial = definition(1);
  library.publish(initial);
  const instance = library.create_instance({
    id: material_instance_id("wall"),
    definition: initial.id,
    variant: material_variant_id("coated"),
  });
  assertEquals(library.replace([definition(2, false)]), {
    type: "rejected",
    reason:
      "replacement material stone invalidates instance wall: material instance wall requests missing variant coated from stone",
  });
  assertEquals(library.definition(initial.id)?.revision, 1);
  assertEquals(library.instance(instance.id)?.revision, 0);
});

Deno.test("instance updates are bounded overrides and advance only that instance", () => {
  const library = new MaterialLibrary();
  const material = definition(1);
  library.publish(material);
  const first = library.create_instance({
    id: material_instance_id("first"),
    definition: material.id,
  });
  const second = library.create_instance({
    id: material_instance_id("second"),
    definition: material.id,
  });
  const updated = library.update_instance(first.id, {
    overrides: { metallic: 1 },
  });
  assertEquals(updated.revision, 1);
  assertEquals(library.instance(second.id)?.revision, 0);
  assertEquals(library.counts(), { definitions: 1, instances: 2 });
});

Deno.test("instance overrides cannot silently enable an undeclared pipeline feature", () => {
  const library = new MaterialLibrary();
  const plain = create_material_definition({
    id: material_definition_id("plain"),
    revision: 0,
    parameters: default_pbr_parameters(),
    alpha: { type: "opaque" },
    sidedness: "front",
  });
  library.publish(plain);
  assertThrows(
    () =>
      library.create_instance({
        id: material_instance_id("glass"),
        definition: plain.id,
        overrides: { transmission: 0.5 },
      }),
    Error,
    "material plain instance override cannot enable undeclared feature transmission",
  );
});
