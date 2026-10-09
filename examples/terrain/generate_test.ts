/**
 * The generators on a reduced world (the same code as `deno task gen:terrain`,
 * 256 cells instead of 2048): deterministic output, placements that obey their
 * rules, meshes with the promised triangle counts, and the committed scene.
 */
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { Heightfield, ScatterSet } from "@ink/geometry";
import { parseGltf } from "@ink/render";
import {
  generateHeightfield,
  groundAt,
  layerAt,
  LAYERS,
  slopeAt,
  terrainParamsFor,
  WATER_LEVEL,
} from "./scripts/world.ts";
import { describeTerrain } from "./scripts/terrain.ts";
import { placeScatter, RULES, TARGETS } from "./scripts/scatter.ts";
import { generateMeshes } from "./scripts/meshes.ts";
import { generateTextures } from "./scripts/textures.ts";
import { buildScene, sceneText } from "./scripts/scene.ts";

const root = fromFileUrl(new URL(".", import.meta.url));
const params = terrainParamsFor();
const small = () => generateHeightfield({ cells: 256, splatCells: 128 });
const field = small();
const SCALE = 0.04;
const placed = placeScatter(field, params, { scale: SCALE });

Deno.test("the terrain is deterministic and well formed", () => {
  const again = small();
  const bytes = field.serialize();
  assertEquals(bytes, again.serialize());
  const copy = Heightfield.parse(bytes);
  assertEquals(copy.heights, field.heights);
  assertEquals(copy.splat, field.splat);
  assertEquals(copy.layers, 4);

  const info = describeTerrain(field);
  assert(info.low >= 0 && info.low < 3, `lowest ${info.low}`);
  assert(info.high > 190 && info.high <= 226, `highest ${info.high}`);
  assert(info.water > 0.005 && info.water < 0.08, `water ${info.water}`);
  for (let i = 0; i < LAYERS.length; i++) {
    assert(info.coverage[i] > 0.01, `${LAYERS[i]} covers ${info.coverage[i]}`);
  }
  assert(info.coverage[0] > 0.4, "mostly grass");
  // Every splat texel is a full set of weights.
  for (let i = 0; i < field.splatCells ** 2; i++) {
    const o = i * 4;
    assertEquals(
      field.splat[o] + field.splat[o + 1] + field.splat[o + 2] +
        field.splat[o + 3],
      255,
    );
  }
});

Deno.test("scatter placements are deterministic", () => {
  const again = placeScatter(small(), params, { scale: SCALE });
  for (const key of ["pines", "oaks", "rocks", "grass"] as const) {
    assertEquals(placed[key].serialize(), again[key].serialize(), key);
  }
});

const all = (set: ScatterSet) =>
  Array.from({ length: set.count }, (_, i) => set.get(i));

Deno.test("every placement lies inside the terrain and follows its rules", () => {
  const limit = params.size / 2 - RULES.margin + 1e-3;
  const counts = {
    pines: Math.round(TARGETS.pine * SCALE),
    oaks: Math.round(TARGETS.oak * SCALE),
    rocks: Math.round(TARGETS.rock * SCALE),
    grass: Math.round(TARGETS.grass * SCALE),
  };
  for (const key of ["pines", "oaks", "rocks", "grass"] as const) {
    const set = placed[key];
    assert(
      set.count >= counts[key] * 0.9,
      `${key}: ${set.count} of ${counts[key]}`,
    );
    const kind = {
      pines: "pine",
      oaks: "oak",
      rocks: "rock",
      grass: "grass",
    }[key] as keyof typeof RULES.scale;
    const [lo, hi] = RULES.scale[kind];
    for (const p of all(set)) {
      assert(Math.abs(p.x) <= limit && Math.abs(p.z) <= limit, `${key} inside`);
      assertEquals(p.y, 0);
      assert(
        p.scale >= lo - 1e-6 && p.scale <= hi + 1e-6,
        `${key} scale ${p.scale}`,
      );
      assert(p.tint >= 0 && p.tint <= 1, `${key} tint`);
      assert(p.yaw >= 0 && p.yaw <= Math.PI * 2 + 1e-6, `${key} yaw`);
      const height = groundAt(field, params, p.x, p.z);
      assert(height > WATER_LEVEL, `${key} is dry at ${p.x}, ${p.z}`);
      const away = Math.hypot(p.x - placed.spawn[0], p.z - placed.spawn[1]);
      if (key === "pines" || key === "oaks") {
        const rule = RULES[key === "pines" ? "pine" : "oak"];
        assert(
          height >= rule.minHeight && height <= rule.maxHeight,
          `${key} height ${height}`,
        );
        assert(
          slopeAt(field, params, p.x, p.z) <= rule.maxTan + 1e-9,
          `${key} slope`,
        );
        assert(
          layerAt(field, params, 0, p.x, p.z) >= rule.minGrass,
          `${key} on grass`,
        );
        assert(away >= RULES.clearing, `${key} outside the clearing`);
      } else if (key === "rocks") {
        assert(height >= RULES.rock.minHeight, "rock above water");
        assert(away >= RULES.clearing, "rock outside the clearing");
      } else {
        assert(height >= RULES.grass.minHeight, "grass above the beach");
        assert(
          slopeAt(field, params, p.x, p.z) <= RULES.grass.maxTan + 1e-9,
          "grass slope",
        );
        assert(
          layerAt(field, params, 0, p.x, p.z) >= RULES.grass.minGrass,
          "grass layer",
        );
      }
    }
  }
  // Trees keep their distance from one another.
  const trees = [...all(placed.pines), ...all(placed.oaks)];
  let nearest = Infinity;
  for (let i = 0; i < trees.length; i++) {
    for (let j = i + 1; j < trees.length; j++) {
      nearest = Math.min(
        nearest,
        Math.hypot(trees[i].x - trees[j].x, trees[i].z - trees[j].z),
      );
    }
  }
  assert(nearest > 3, `trees at least 3 m apart, nearest ${nearest}`);
  // The start is open ground.
  const [sx, sz] = placed.spawn;
  assert(slopeAt(field, params, sx, sz) < 0.15, "level start");
  assert(groundAt(field, params, sx, sz) > WATER_LEVEL + 5, "dry start");
});

Deno.test("scatter meshes are single-primitive glTF with the promised detail", async () => {
  const meshes = generateMeshes();
  assertEquals(meshes.map((m) => m.file), [
    "pine.glb",
    "oak.glb",
    "rock.glb",
    "grass.glb",
  ]);
  const expected: Record<string, [number, number, number, number]> = {
    // triangles low/high, height low/high
    "pine.glb": [3500, 5000, 12, 18],
    "oak.glb": [3500, 5000, 10, 16],
    "rock.glb": [1400, 1800, 0.8, 2.5],
    "grass.glb": [40, 80, 0.4, 1.2],
  };
  for (const mesh of meshes) {
    const model = await parseGltf(
      mesh.glb.buffer.slice(
        mesh.glb.byteOffset,
        mesh.glb.byteOffset + mesh.glb.byteLength,
      ) as ArrayBuffer,
      `file:///${mesh.file}`,
    );
    assertEquals(model.meshes.length, 1);
    assertEquals(model.meshes[0].length, 1, `${mesh.file} has one primitive`);
    const data = model.meshes[0][0].mesh;
    const count = data.positions.length / 3;
    assert(data.colors && data.colors.length === count * 4, "vertex colours");
    assertEquals(data.normals.length, data.positions.length);
    assertEquals(data.uvs.length, count * 2);
    const triangles = data.indices.length / 3;
    const [lo, hi, low, high] = expected[mesh.file];
    assert(
      triangles >= lo && triangles <= hi,
      `${mesh.file}: ${triangles} triangles`,
    );
    let top = -Infinity, bottom = Infinity;
    for (let i = 1; i < data.positions.length; i += 3) {
      top = Math.max(top, data.positions[i]);
      bottom = Math.min(bottom, data.positions[i]);
    }
    assert(top >= low && top <= high, `${mesh.file} is ${top} m tall`);
    assert(
      bottom > -0.4 && bottom < 0.1,
      `${mesh.file} stands on the ground (${bottom})`,
    );
  }
  // Deterministic bytes.
  assertEquals(generateMeshes().map((m) => m.glb), meshes.map((m) => m.glb));
});

Deno.test("ground textures are tileable-sized, deterministic and complete", () => {
  const files = generateTextures(64);
  assertEquals(
    Object.keys(files).sort(),
    LAYERS.flatMap((n) => [`${n}.png`, `${n}_n.png`, `${n}_orm.png`]).sort(),
  );
  assertEquals(generateTextures(64)["rock_n.png"], files["rock_n.png"]);
});

Deno.test("the committed scene is what the generators write", async () => {
  // The full-size world: the one `deno task gen:terrain` writes.
  const full = generateHeightfield();
  const scene = sceneText(buildScene(full));
  assertEquals(await Deno.readTextFile(`${root}scenes/main.scene.json`), scene);
});
