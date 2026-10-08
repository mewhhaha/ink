import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  boxBrush,
  builtinMesh,
  mat4,
  quat,
  type Vec3,
  vec3,
} from "@ink/geometry";
import { defineSchema, sceneToWorld, standard } from "@ink/schema";
import { extractScene } from "@ink/render";
import { snapGeometry } from "./snapping.ts";

Deno.test("surface snaps use transformed triangles and ignore the moving selection", () => {
  const schema = defineSchema({
    components: {
      transform: standard.transform,
      brush: standard.brush,
      mesh: standard.mesh,
    },
  });
  const catalog = { assets: { mesh: ["builtin:cube"] } };
  const loaded = sceneToWorld(schema, {
    ink: 1,
    entities: [{
      id: 1,
      components: {
        transform: {
          position: [3, 2, 4],
          rotation: quat.fromEuler([20, 30, 0]),
          scale: [-2, 1, 0.5],
        },
        brush: { faces: boxBrush([-1, -1, -1], [1, 1, 1]) },
      },
    }, {
      id: 2,
      components: {
        transform: { position: [20, 0, 0] },
        mesh: { shape: "builtin:cube" },
      },
    }],
  }, catalog);
  const scene = extractScene(loaded.world, catalog);
  const m = scene.matrices.get(1)!;
  const origin = mat4.transformPoint(m, [0, 10, 0]);
  const direction = vec3.normalize(mat4.transformDirection(m, [0, -1, 0]));
  const expected = mat4.transformPoint(m, [0, 1, 0]);
  const opts = {
    scene,
    exclude: new Set<number>(),
    mode: "surface" as const,
    ray: { origin, direction },
    project: (p: Vec3): [number, number] => [p[0], p[2]],
    screen: [0, 0] as [number, number],
  };
  const hit = snapGeometry(opts)!;
  hit.forEach((v, i) => assertAlmostEquals(v, expected[i], 1e-5));
  assertEquals(snapGeometry({ ...opts, exclude: new Set([1]) }), null);
  const meshHit = snapGeometry({
    ...opts,
    assets: { meshData: () => builtinMesh("builtin:cube") },
    ray: { origin: [20, 10, 0], direction: [0, -1, 0] },
  });
  assertEquals(meshHit, [20, 0.5, 0]);
});

Deno.test("vertex snapping selects the nearest visible-depth vertex within ten pixels", () => {
  const schema = defineSchema({
    components: { transform: standard.transform, brush: standard.brush },
  });
  const catalog = { assets: {} };
  const loaded = sceneToWorld(schema, {
    ink: 1,
    entities: [{
      id: 1,
      components: {
        transform: {},
        brush: { faces: boxBrush([-1, -1, -1], [1, 1, 1]) },
      },
    }],
  }, catalog);
  const scene = extractScene(loaded.world, catalog);
  const options = {
    scene,
    exclude: new Set<number>(),
    mode: "vertex" as const,
    ray: { origin: [1, 10, 1] as Vec3, direction: [0, -1, 0] as Vec3 },
    project: (p: Vec3): [number, number] => [100 * p[0], 100 * p[2]],
    screen: [103, 98] as [number, number],
  };
  assertEquals(snapGeometry(options), [1, 1, 1]);
  assertEquals(snapGeometry({ ...options, screen: [150, 150] }), null);
});
