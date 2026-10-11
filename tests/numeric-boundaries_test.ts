import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(
  new URL("./numeric-boundaries.blot", import.meta.url),
);
function call(name: string, a: number[]) {
  return Array.from(
    fixture.guest.call(name, new Float32Array(a)) as Float32Array,
  );
}
Deno.test("checked quaternions reject nonfinite values and normalize zero, tiny and huge finite inputs", () => {
  assertEquals(call("quaternion", [0, 0, 0, 0]), [0, 0, 0, 1]);
  for (const scale of [1e-30, 1, 1e30]) {
    const q = call("quaternion", [scale, 0, 0, scale]);
    assertAlmostEquals(q[0], Math.SQRT1_2, 1e-6);
    assertAlmostEquals(q[3], Math.SQRT1_2, 1e-6);
  }
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assertEquals(call("quaternion", [invalid, 0, 0, 1]), []);
  }
  assertEquals(call("directions", [0, 0, 0]), [0, 0, 0, 1, 0, 0, 0, 1]);
  for (const y of [-1, 1]) {
    const q = call("directions", [0, y, 0]).slice(0, 4);
    assertAlmostEquals(Math.hypot(...q), 1, 1e-6);
    // Rotation's local -Z column equals the requested vertical direction.
    assertAlmostEquals(-2 * (q[1] * q[2] - q[0] * q[3]), y, 1e-6);
  }
});
Deno.test("checked vector normalization rejects zero and keeps extreme directions unit length", () => {
  assertEquals(call("normalize_vector", [0, 0, 0]), []);
  for (const size of [1e-30, 1, 1e30]) {
    const v = call("normalize_vector", [size, size, 0]);
    assertAlmostEquals(v[0], Math.SQRT1_2, 1e-6);
    assertAlmostEquals(Math.hypot(...v), 1, 1e-6);
  }
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assertEquals(call("normalize_vector", [invalid, 0, 0]), []);
    assertEquals(
      Array.from(fixture.guest.call("pick", invalid) as Float32Array),
      [],
    );
  }
  const direction = fixture.guest.call("pick", 1e30) as Float32Array;
  assertAlmostEquals(Math.hypot(...direction), 1, 1e-6);
});
Deno.test("checked projection rejects invalid poses, points and singular clip division", () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (const i of [0, 1, 2, 3]) {
      const a = [0, 1, 1, -4];
      a[i] = invalid;
      assertEquals(call("project", a), []);
    }
    assertEquals(
      Array.from(fixture.guest.call("unproject", invalid) as Float32Array),
      [],
    );
  }
  assertEquals(call("project", [0, 1, 1, 0]), []);
  assert(call("project", [0, 0, 1, -4]).every(Number.isFinite));
});
Deno.test("logarithm validates positive finite inputs and unchecked normalization is bounded", () => {
  for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
    assertEquals(
      Array.from(fixture.guest.call("logarithm", invalid) as Float32Array),
      [],
    );
    assert(
      Number.isFinite(fixture.guest.call("unchecked_log", invalid) as number),
    );
  }
  for (const value of [1e-38, 0.125, 1, 2, 1e38]) {
    const result = fixture.guest.call("logarithm", value) as Float32Array;
    const expected = Math.log2(Math.max(Math.fround(value), 1.17549435e-38));
    assertAlmostEquals(result[0], expected, 2e-5);
  }
});
Deno.test("tone mapping retains finite extreme HDR values", () => {
  for (const value of [1e10, 1e20, 1e38]) {
    assertEquals(fixture.guest.call("tone", value), 1);
  }
});
Deno.test("checked springs reject invalid or unbounded phase and preserve zero-duration state", () => {
  const initial = [3, -2, 1, 5, 0.3, 0.2];
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (let i = 0; i < initial.length; i++) {
      const a = [...initial];
      a[i] = invalid;
      assertEquals(call("spring", a), []);
    }
  }
  assertEquals(call("spring", [3, -2, 1, 5, 0.3, 0]), [3, -2]);
  assertEquals(call("spring", [3, -2, 1, 10000, 0.3, 1]), []);
  assertEquals(call("spring", [3, -2, 1, -5, 0.3, 0.2]), []);
});
Deno.test("animation validates once, keeps duplicate-key choice and empty-track identity", () => {
  assertEquals(call("validate_clip", [1, 0.5, 0.5]), [0]);
  assertEquals(
    call("validate_clip", [1, 0.5, 0.5, 0, 0, 0.5, 2, 0.5, 4, 1, 10]),
    [4],
  );
  assertEquals(call("validate_clip", [1, 0.5, 0.5, 0.7, 7, 0.5, 5]), []);
  for (const invalid of [0, -1, NaN, Infinity]) {
    assertEquals(call("validate_clip", [invalid, 0, 0]), []);
  }
  for (const invalid of [-0.1, 1, NaN, Infinity]) {
    assertEquals(call("validate_clip", [1, invalid, 0]), []);
  }
  assertEquals(call("validate_clip", [1, 0, 0, 0, Infinity]), []);
  assertEquals(
    fixture.guest.call("parents", new Uint32Array([0xffffffff, 0, 1])),
    true,
  );
  assertEquals(
    fixture.guest.call("parents", new Uint32Array([0xffffffff, 1])),
    false,
  );
  assertEquals(
    fixture.guest.call("parents", new Uint32Array([1, 0xffffffff])),
    false,
  );
});
Deno.test("animation windows remain bounded for invalid, reverse and extreme loop intervals", () => {
  assertEquals(call("window", [1, 0.8, 2.2]), [14, 2]);
  assertEquals(call("window", [1, 2.2, 0.8]), [-14, 0]);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assertEquals(call("window", [1, 0, invalid]), [0, 0]);
  }
  assertEquals(call("window", [1, 0, 4096]), [40960, 0]);
  assertEquals(call("window", [1, 0, 1e30]), [0, 0]);
  assertEquals(call("window", [1e-38, 0, 1]), [0, 0]);
});
Deno.test("audio ingestion rejects invalid configuration before querying and handles coincident zero-direction sound", () => {
  assertEquals(call("sound", [1, 0, 1]), [1, 0, 1, 20000]);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (let i = 0; i < 3; i++) {
      const a = [1, 6, 1];
      a[i] = invalid;
      assertEquals(call("sound", a), []);
    }
  }
  assertEquals(call("sound", [0, 6, 1]), []);
  assertEquals(call("sound", [1, 6, -1]), []);
});
Deno.test.afterAll(() => fixture.dispose());
