import { vec3 } from "@ink/math/vector.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { global_position } from "./identity.ts";
import { create_terrain } from "./terrain.ts";
import { place_vegetation } from "./vegetation.ts";

Deno.test("vegetation placement is stable and revision-scoped", () => {
  const terrain = create_terrain({
    origin: global_position(0, 0, vec3(0, 0, 0), 100),
    width: 5,
    depth: 5,
    spacing: 1,
    heights: new Float32Array(25),
  });
  const input = {
    seed: 12n,
    generator_version: "1",
    region_revision: 3,
    terrain,
    spacing: 1,
    density: new Float32Array(25).fill(1),
    exclusions: new Uint8Array(25),
    species: [{ id: "tree", weight: 1 }],
    maximum_instances: 100,
  };
  const first = place_vegetation(input);
  const second = place_vegetation(input);
  assertEquals(first, second);
  assertEquals(first.length > 0, true);
  assertEquals(
    place_vegetation({ ...input, region_revision: 4 }).map(({ id }) => id)
      .some((id, index) => id === first[index]?.id),
    false,
  );
});

Deno.test("strategy vegetation recipe matches its golden output", () => {
  const terrain = create_terrain({
    origin: global_position(0, 0, vec3(0, 0, 0), 64),
    width: 7,
    depth: 5,
    spacing: 4,
    heights: new Float32Array(35),
  });
  const exclusions = new Uint8Array(35);
  for (const [x, z] of [[1, 2], [2, 1], [4, 3], [6, 2]]) {
    exclusions[z * terrain.width + x] = 1;
  }
  const instances = place_vegetation({
    seed: 2_253_359_092n,
    generator_version: "strategy-v1",
    region_revision: 4,
    terrain,
    spacing: 3,
    density: new Float32Array(35).fill(0.86),
    exclusions,
    species: [{
      id: "frontier-pine",
      weight: 1,
      minimum_scale: 0.72,
      maximum_scale: 1.25,
    }],
    maximum_instances: 12,
  });
  assertEquals(instances.slice(0, 2), [
    {
      id: "vegetation:d0c2edbe18f5baf5",
      species: "frontier-pine",
      position: vec3(2.1397666141718625, 0, 1.1663895717087112),
      rotation_radians: 4.325180182426856,
      scale: 1.1198917090080878,
    },
    {
      id: "vegetation:cd9b0e0ded69d13c",
      species: "frontier-pine",
      position: vec3(5.209020964842439, 0, 0.032527137353846824),
      rotation_radians: 3.110106034271247,
      scale: 1.1546360489170935,
    },
  ]);
});

Deno.test("vegetation exclusions prevent placement at masked vertices", () => {
  const terrain = create_terrain({
    origin: global_position(0, 0, vec3(0, 0, 0), 10),
    width: 2,
    depth: 2,
    spacing: 1,
    heights: new Float32Array(4),
  });
  assertEquals(
    place_vegetation({
      seed: 1n,
      generator_version: "1",
      region_revision: 0,
      terrain,
      spacing: 1,
      density: new Float32Array(4).fill(1),
      exclusions: new Uint8Array(4).fill(1),
      species: [{ id: "grass", weight: 1 }],
      maximum_instances: 10,
    }),
    [],
  );
});

Deno.test("vegetation rejects candidate grids too large to evaluate", () => {
  const terrain = create_terrain({
    origin: global_position(0, 0, vec3(0, 0, 0), 10),
    width: 2,
    depth: 2,
    spacing: 1,
    heights: new Float32Array(4),
  });
  assertThrows(
    () =>
      place_vegetation({
        seed: 1n,
        generator_version: "1",
        region_revision: 0,
        terrain,
        spacing: 0.0001,
        density: new Float32Array(4),
        exclusions: new Uint8Array(4),
        species: [{ id: "grass", weight: 1 }],
        maximum_instances: 1,
      }),
    Error,
    "exceeds 16777216 candidates",
  );
});
