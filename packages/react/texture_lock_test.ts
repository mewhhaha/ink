import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  boxBrush,
  type BrushFace,
  brushPolygons,
  brushUv,
  mat4,
  quat,
  transformBrush,
  type Vec3,
} from "@ink/geometry";
import { defineSchema, sceneToWorld, standard } from "@ink/schema";
import { worldMatrices } from "@ink/render";
import { stationaryBrushTextures } from "./texture_lock.ts";

Deno.test("texture lock preserves coordinates through a mirrored affine edit", () => {
  const faces = boxBrush([-1, -2, -3], [1, 2, 3]).map((f) => ({
    ...f,
    rotation: 31,
    scale: [0.7, -1.3] as [number, number],
    offset: [21, -9] as [number, number],
  }));
  const edit = mat4.multiply(
    mat4.compose([3, 7, -1], quat.fromEuler([15, 23, 40]), [-2, 3, 0.4]),
    mat4.compose([0, 0, 0], quat.fromEuler([20, 0, 50]), [1, 2, 1]),
  );
  const locked = transformBrush(faces, edit, true);
  const polygons = brushPolygons(faces.map((f) => f.plane));
  polygons.forEach((poly, i) =>
    poly.forEach((point) => {
      const before = brushUv(faces[i], point);
      const after = brushUv(locked[i], mat4.transformPoint(edit, point));
      before.forEach((v, k) => assertAlmostEquals(v, after[k], 1e-5));
    })
  );
});

Deno.test("unlocked textures stay fixed in world space when a parent moves", () => {
  const schema = defineSchema({
    components: { transform: standard.transform, brush: standard.brush },
  });
  const before = sceneToWorld(schema, {
    ink: 1,
    entities: [
      {
        id: 1,
        components: {
          transform: {
            rotation: quat.fromEuler([20, 30, 10]),
            scale: [-2, 3, 1],
          },
        },
      },
      {
        id: 2,
        parent: 1,
        components: {
          transform: { position: [0, 2, 0] },
          brush: { faces: boxBrush([-1, -1, -1], [1, 1, 1]) },
        },
      },
    ],
  }, { assets: {} }).world;
  const world = structuredClone(before);
  const preserve = stationaryBrushTextures(before);
  world.entities[0].components.transform.position = [2, 5, -7];
  world.entities[0].components.transform.rotation = quat.fromEuler([
    50,
    -20,
    70,
  ]);
  const oldMatrix = worldMatrices(before).get(2)!;
  const newMatrix = worldMatrices(world).get(2)!;
  preserve(world);
  const oldFaces = before.entities[1].components.brush
    .faces as unknown as BrushFace[];
  const faces = world.entities[1].components.brush
    .faces as unknown as BrushFace[];
  for (const [i, face] of faces.entries()) {
    for (const point of [[0, 1, 0], [1, -2, 3]] as Vec3[]) {
      const priorLocal = mat4.transformPoint(
        mat4.invert(oldMatrix),
        mat4.transformPoint(newMatrix, point),
      );
      const expected = brushUv(oldFaces[i], priorLocal);
      brushUv(face, point).forEach((v, k) =>
        assertAlmostEquals(v, expected[k], 1e-5)
      );
    }
    assertEquals(face.plane, oldFaces[i].plane);
  }
});
