import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("convex search retains redundant face topology and analytic rotated box gaps", async () => {
  const fixture = await compile(
    new URL("./geometry_performance.blot", import.meta.url),
  );
  try {
    for (const angle of [0, 0.17, 0.63, 1.1]) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const rotate = ([x, y, z]: number[]) => [c * x - s * z, y, s * x + c * z];
      const normals = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
      const points = [[2, 0.1, 0.2], [2, 2, 0.2], [2, 2, 2], [0.1, 0.9, 0.2]];
      for (const copies of [1, 2, 8]) {
        const planes = Array.from(
          { length: copies * 6 },
          (_, i) => [...rotate(normals[i % 6]), 1],
        );
        const input = new Float32Array([
          planes.length,
          ...planes.flat(),
          ...points.flatMap(rotate),
        ]);
        const output = fixture.guest.call("hull", input) as Float32Array;
        assertEquals(Array.from(output.slice(0, 3)), [
          8,
          copies * 6,
          copies * 12,
        ]);
        const vertices = Array.from(
          { length: 8 },
          (_, i) => Array.from(output.slice(3 + i * 3, 6 + i * 3)),
        );
        let cursor = 27;
        for (let face = 0; face < copies * 6; face++) {
          const plane = Array.from(output.slice(cursor, cursor + 4));
          const length = output[cursor + 4];
          assertEquals(length, 4);
          const ids = Array.from(output.slice(cursor + 5, cursor + 5 + length));
          assertEquals(new Set(ids).size, 4);
          let orientedArea = 0;
          for (let i = 0; i < length; i++) {
            const a = vertices[ids[i]];
            const b = vertices[ids[(i + 1) % length]];
            assertAlmostEquals(
              a[0] * plane[0] + a[1] * plane[1] + a[2] * plane[2],
              plane[3],
              2e-6,
            );
            orientedArea += (a[1] * b[2] - a[2] * b[1]) * plane[0] +
              (a[2] * b[0] - a[0] * b[2]) * plane[1] +
              (a[0] * b[1] - a[1] * b[0]) * plane[2];
          }
          assert(orientedArea > 0);
          cursor += 5 + length;
        }
        for (const point of points) {
          let closest = point.map((v) => Math.max(-1, Math.min(1, v)));
          let distance = Math.hypot(...point.map((v, i) => v - closest[i]));
          let normal = point.map((v, i) => (v - closest[i]) / distance);
          if (distance === 0) {
            closest = [...point];
            closest[1] = 1;
            distance = point[1] - 1;
            normal = [0, 1, 0];
          }
          assertAlmostEquals(output[cursor], distance, 2e-6);
          const expected = [...rotate(normal), ...rotate(closest)];
          for (let i = 0; i < expected.length; i++) {
            assertAlmostEquals(output[cursor + 1 + i], expected[i], 2e-6);
          }
          cursor += 7;
        }
        assertEquals(cursor, output.length);
      }
    }
  } finally {
    await fixture.dispose();
  }
});

Deno.test("near parallel distinct clipping planes keep their tighter half-space", async () => {
  const fixture = await compile(
    new URL("./geometry_performance.blot", import.meta.url),
  );
  try {
    const planes = [
      [1, 0, 0, 1],
      [-1, 0, 0, 1],
      [0, 1, 0, 1],
      [0, -1, 0, 1],
      [0, 0, 1, 1],
      [0, 0, -1, 1],
      [1, 0, 0, 0.99],
      [1, 0.0001, 0, 0.99],
    ];
    const input = new Float32Array([
      planes.length,
      ...planes.flat(),
      2,
      0.8,
      0,
    ]);
    const output = fixture.guest.call("hull", input) as Float32Array;
    assert(output.length > 0);
    for (let i = 0; i < output[0]; i++) {
      const x = output[3 + i * 3];
      const y = output[4 + i * 3];
      assert(x <= 0.990001);
      assert(x + 0.0001 * y <= 0.990501);
    }
    assertAlmostEquals(output[output.length - 7], 1.01008, 0.0003);
  } finally {
    await fixture.dispose();
  }
});
