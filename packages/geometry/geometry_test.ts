import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  aabbEmpty,
  aabbGrow,
  aabbTransform,
  aabbUnion,
  boxBrush,
  brushBounds,
  brushEdges,
  brushMesh,
  brushPolygons,
  builtinMesh,
  clipBrush,
  intersectAabb,
  intersectPlane,
  intersectSphere,
  intersectTriangle,
  mat4,
  meshBounds,
  pointInBrush,
  quat,
  rayFromNdc,
  snap,
  transformBrush,
  translateBrush,
  type Vec3,
  vec3,
} from "./mod.ts";

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) => {
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) assertAlmostEquals(a[i], b[i], eps);
};

Deno.test("vec3 basics", () => {
  assertEquals(vec3.cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  near(vec3.normalize([3, 0, 4]), [0.6, 0, 0.8]);
  assertEquals(vec3.normalize([0, 0, 0]), [0, 0, 0]);
});

Deno.test("quat rotate, euler round trip, lookRotation", () => {
  near(quat.rotate(quat.fromAxisAngle([0, 1, 0], Math.PI / 2), [1, 0, 0]), [
    0,
    0,
    -1,
  ]);
  for (const e of [[10, 20, 30], [-45, 120, 5], [80, -170, -60]] as Vec3[]) {
    near(quat.toEuler(quat.fromEuler(e)), e, 1e-3);
  }
  // Yaw 90 turns -Z (forward) toward -X.
  near(quat.rotate(quat.fromEuler([0, 90, 0]), [0, 0, -1]), [-1, 0, 0]);
  const q = quat.lookRotation([1, 0, 0]);
  near(quat.rotate(q, [0, 0, -1]), [1, 0, 0]);
  near(quat.rotate(q, [0, 1, 0]), [0, 1, 0]);
  near(quat.rotate(quat.lookRotation([0, -1, 0]), [0, 0, -1]), [0, -1, 0]);
  const s = quat.slerp(
    quat.identity(),
    quat.fromAxisAngle([0, 1, 0], Math.PI / 2),
    0.5,
  );
  near(s, quat.fromAxisAngle([0, 1, 0], Math.PI / 4));
});

Deno.test("mat4 compose/decompose/invert", () => {
  const r = quat.fromEuler([20, 40, 60]);
  const m = mat4.compose([1, 2, 3], r, [2, 3, 4]);
  const d = mat4.decompose(m);
  near(d.t, [1, 2, 3]);
  near(d.s, [2, 3, 4]);
  near(mat4.compose(d.t, d.r, d.s), m, 1e-4);
  near(mat4.multiply(m, mat4.invert(m)), mat4.identity(), 1e-5);
  near(
    mat4.transformPoint(m, [1, 0, 0]),
    vec3.add(quat.rotate(r, [2, 0, 0]), [1, 2, 3]),
  );
});

Deno.test("perspective maps near/far to depth 0..1 and rays unproject", () => {
  const p = mat4.perspective(Math.PI / 2, 2, 0.5, 100);
  near(mat4.transformPoint(p, [0, 0, -0.5]), [0, 0, 0]);
  near(mat4.transformPoint(p, [0, 0, -100]), [0, 0, 1], 1e-4);
  const view = mat4.lookAt([0, 0, 5], [0, 0, 0]);
  const inv = mat4.invert(mat4.multiply(p, view));
  const ray = rayFromNdc(inv, [0, 0]);
  near(ray.direction, [0, 0, -1], 1e-4);
  const hit = intersectPlane(ray, [0, 0, 1, 0])!;
  assertAlmostEquals(hit, 4.5, 1e-3); // the ray starts on the near plane
  const o = mat4.orthographic(-2, 2, -1, 1, 0.1, 50);
  near(mat4.transformPoint(o, [2, 1, -0.1]), [1, 1, 0], 1e-6);
  near(mat4.transformPoint(o, [0, 0, -50]), [0, 0, 1], 1e-6);
});

Deno.test("ray intersections", () => {
  const ray = { origin: [0, 0, 5] as Vec3, direction: [0, 0, -1] as Vec3 };
  assertEquals(intersectAabb(ray, { min: [-1, -1, -1], max: [1, 1, 1] }), 4);
  assertEquals(intersectAabb(ray, { min: [2, 2, -1], max: [3, 3, 1] }), null);
  assertAlmostEquals(intersectSphere(ray, [0, 0, 0], 1)!, 4);
  assertAlmostEquals(
    intersectTriangle(ray, [-1, -1, 0], [1, -1, 0], [0, 1, 0])!,
    5,
  );
  assertEquals(intersectTriangle(ray, [2, 2, 0], [3, 2, 0], [2, 3, 0]), null);
});

Deno.test("builtin meshes have the documented sizes and valid winding", () => {
  const expect: Record<string, [Vec3, Vec3]> = {
    "builtin:cube": [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
    "builtin:sphere": [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
    "builtin:plane": [[-0.5, 0, -0.5], [0.5, 0, 0.5]],
    "builtin:cylinder": [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
    "builtin:cone": [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
    "builtin:capsule": [[-0.25, -0.5, -0.25], [0.25, 0.5, 0.25]],
  };
  for (const [path, [min, max]] of Object.entries(expect)) {
    const mesh = builtinMesh(path)!;
    const b = meshBounds(mesh);
    near(b.min, min);
    near(b.max, max);
    // Every triangle's geometric normal agrees with its vertex normals.
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const v = [0, 1, 2].map((k) => {
        const j = mesh.indices[i + k] * 3;
        return [
          mesh.positions[j],
          mesh.positions[j + 1],
          mesh.positions[j + 2],
        ] as Vec3;
      });
      const g = vec3.cross(vec3.sub(v[1], v[0]), vec3.sub(v[2], v[0]));
      const j = mesh.indices[i] * 3;
      const n: Vec3 = [
        mesh.normals[j],
        mesh.normals[j + 1],
        mesh.normals[j + 2],
      ];
      assert(vec3.dot(g, n) >= -1e-9, `${path} triangle ${i / 3} faces inward`);
    }
  }
  assertEquals(builtinMesh("models/x.glb"), undefined);
});

const box = () => boxBrush([-1, 0, -2], [1, 2, 2]);

Deno.test("brush polygons wind counter-clockwise from outside", () => {
  const faces = box();
  const polys = brushPolygons(faces.map((f) => f.plane));
  assertEquals(polys.map((p) => p.length), [4, 4, 4, 4, 4, 4]);
  polys.forEach((poly, i) => {
    const n = faces[i].plane;
    const g = vec3.cross(
      vec3.sub(poly[1], poly[0]),
      vec3.sub(poly[2], poly[0]),
    );
    assert(vec3.dot(g, [n[0], n[1], n[2]]) > 0);
  });
  assertEquals(brushEdges(faces.map((f) => f.plane)).length, 12);
  assertEquals(brushBounds(faces), { min: [-1, 0, -2], max: [1, 2, 2] });
});

Deno.test("brush polygons skip redundant, duplicate and empty faces", () => {
  const faces = box();
  const extra = [...faces.map((f) => f.plane), [1, 0, 0, 5], [0, 1, 0, 2]] as [
    number,
    number,
    number,
    number,
  ][];
  const polys = brushPolygons(extra);
  assertEquals(polys[6].length, 0); // redundant far plane
  assertEquals(polys[7].length, 0); // duplicate of face 2
  assertEquals(polys[2].length, 4);
  assertEquals(brushBounds([[1, 0, 0, 0], [-1, 0, 0, -1]]), null); // empty
});

Deno.test("brush mesh: triangles, face map, texture projection", () => {
  const mesh = brushMesh(box());
  assertEquals(mesh.indices.length, 36);
  assertEquals(mesh.faceOfTriangle.length, 12);
  assertEquals(Array.from(mesh.faceOfTriangle.slice(0, 2)), [0, 0]);
  // A wall (+Z face) at scale 1 repeats a 64 px texture once per metre.
  const faces = box();
  const wall = brushMesh(faces, () => [64, 64]);
  const vi = Array.from(wall.faceOfVertex).indexOf(4);
  const i = vi * 3, u = wall.uvs[vi * 2], v = wall.uvs[vi * 2 + 1];
  assertAlmostEquals(u, wall.positions[i], 1e-5);
  assertAlmostEquals(v, -wall.positions[i + 1], 1e-5);
  faces[4] = { ...faces[4], scale: [2, 2], offset: [32, 0], rotation: 0 };
  const scaled = brushMesh(faces, () => [64, 64]);
  assertAlmostEquals(scaled.uvs[vi * 2], wall.positions[i] / 2 + 0.5, 1e-5);
  const rot = brushMesh(
    faces.map((f, k) =>
      k === 4 ? { ...f, scale: [1, 1], offset: [0, 0], rotation: 90 } : f
    ),
    () => [64, 64],
  );
  // 90 degrees: (a, b) -> (-b, a).
  assertAlmostEquals(rot.uvs[vi * 2], wall.positions[i + 1], 1e-5);
});

Deno.test("transform, translate, clip and containment", () => {
  const faces = box();
  const moved = translateBrush(faces, [10, 0, 0]);
  assertEquals(brushBounds(moved), { min: [9, 0, -2], max: [11, 2, 2] });
  const m = mat4.compose([1, 0, 0], quat.fromEuler([0, 90, 0]), [2, 1, 1]);
  const t = transformBrush(faces, m);
  const b = brushBounds(t)!;
  const expected = aabbTransform({ min: [-1, 0, -2], max: [1, 2, 2] }, m);
  near(b.min, expected.min, 1e-4);
  near(b.max, expected.max, 1e-4);
  const mirrored = transformBrush(
    faces,
    mat4.compose([0, 0, 0], quat.identity(), [-1, 1, 1]),
  );
  assertEquals(brushBounds(mirrored), { min: [-1, 0, -2], max: [1, 2, 2] });
  assertEquals(
    pointInBrush(faces.map((f) => f.plane), [0, 1, 0]),
    true,
  );
  assertEquals(pointInBrush(faces.map((f) => f.plane), [3, 1, 0]), false);

  const cut = clipBrush(faces, [1, 0, 0, 0.5]);
  assertEquals(brushBounds(cut.back!), { min: [-1, 0, -2], max: [0.5, 2, 2] });
  assertEquals(brushBounds(cut.front!), { min: [0.5, 0, -2], max: [1, 2, 2] });
  const miss = clipBrush(faces, [1, 0, 0, 5]);
  assertEquals(miss.front, null);
  assertEquals(brushBounds(miss.back!), { min: [-1, 0, -2], max: [1, 2, 2] });
});

Deno.test("snap", () => {
  assertEquals(snap(1.3, 0.5), 1.5);
  assertEquals(snap(1.3, 0), 1.3);
  assertEquals(Object.is(snap(-0.1, 1), 0), true);
});

Deno.test("aabbGrow matches the union of a transformed box", () => {
  const local = { min: [-1, -0.5, -2] as Vec3, max: [3, 1.5, 0.25] as Vec3 };
  let reference = aabbEmpty();
  const grown = aabbEmpty();
  for (let i = 0; i < 20; i++) {
    const m = mat4.compose(
      [i - 5, 2 * i, -i],
      quat.fromEuler([i * 17, i * 31, i * 7]),
      // Some mirrored, some squashed.
      [1 + i / 4, i % 3 ? 0.5 : -2, i % 2 ? 1 : -1],
    );
    reference = aabbUnion(reference, aabbTransform(local, m));
    aabbGrow(grown, local, m);
  }
  near(grown.min, reference.min, 1e-9);
  near(grown.max, reference.max, 1e-9);
});
