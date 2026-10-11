import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./render-math.blot", import.meta.url));
function call(name: string, values: number[]) {
  return Array.from(
    fixture.guest.call(name, new Float32Array(values)) as Float32Array,
  );
}
function near(a: number[], b: number[], tolerance = 1e-5) {
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) assertAlmostEquals(a[i], b[i], tolerance);
}
function linear(x: number) {
  if (x <= 0.04045) return x / 12.92;
  return ((x + 0.055) / 1.055) ** 2.4;
}
function srgb(x: number) {
  if (x <= 0.0031308) return x * 12.92;
  return 1.055 * x ** (1 / 2.4) - 0.055;
}
function tone(x: number) {
  x = Math.max(0, x);
  return Math.min(1, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
}
Deno.test("sRGB, alpha, HDR exposure and tone mapping match host transfer functions", () => {
  for (const value of [0, 0.0031308, 0.04045, 0.18, 0.5, 1, 4]) {
    const c = [value, value * 0.5, value * 1.5];
    const r = call("channels", [...c, 0.37, 1.5, 0.125, 2.4, -3.5]);
    near(r.slice(0, 4), [...c.map(linear), 0.37], 2e-4);
    near(r.slice(4, 8), [...c, 0.37], 2e-5);
    near(r.slice(8, 11), c.map(tone));
    near(r.slice(11, 14), c.map((v) => srgb(tone(v * 2 ** 1.5))), 2e-5);
    near(r.slice(14), [
      c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722,
      0.125 ** 2.4,
      2 ** -3.5,
      -3,
    ]);
  }
});
function normalized(v: number[]) {
  const length = Math.hypot(...v);
  return v.map((x) => x / length);
}
function dot(a: number[], b: number[]) {
  return a.reduce((sum, x, i) => sum + x * b[i], 0);
}
function brdfReference(a: number[]) {
  const base = a.slice(0, 3),
    metal = Math.max(0, Math.min(1, a[3])),
    rough = Math.max(0.04, Math.min(1, a[4]));
  const n = normalized(a.slice(5, 8)),
    v = normalized(a.slice(8, 11)),
    l = normalized(a.slice(11, 14));
  const nl = Math.max(0, Math.min(1, dot(n, l))),
    nv = Math.max(1e-5, dot(n, v));
  if (nl <= 0 || dot(n, v) <= 0) return [0, 0, 0];
  const h = normalized(v.map((x, i) => x + l[i])),
    nh = Math.max(0, Math.min(1, dot(n, h))),
    vh = Math.max(0, Math.min(1, dot(v, h)));
  const a2 = rough ** 4,
    den = nh * nh * (a2 - 1) + 1,
    D = a2 / (Math.PI * den * den);
  const visibility = 0.5 /
    Math.max(
      1e-6,
      nl * Math.sqrt(nv * nv * (1 - a2) + a2) +
        nv * Math.sqrt(nl * nl * (1 - a2) + a2),
    );
  return base.map((b) => {
    const f0 = 0.04 + (b - 0.04) * metal, F = f0 + (1 - f0) * (1 - vh) ** 5;
    return ((1 - F) * b * (1 - metal) / Math.PI + F * D * visibility) * nl;
  });
}
Deno.test("GGX matches independent host arithmetic including grazing and metal limits", () => {
  for (const metal of [0, 0.5, 1]) {
    for (const rough of [0.1, 0.5, 1]) {
      for (const view of [[0, 1, 0], [1, 0.1, 0]]) {
        for (const light of [[0, 1, 0], [0.3, 0.5, -0.2], [0, -1, 0]]) {
          const args = [
            0.8,
            0.3,
            0.05,
            metal,
            rough,
            0,
            1,
            0,
            ...view,
            ...light,
          ];
          const expected = brdfReference(args);
          near(
            call("brdf", args),
            expected,
            Math.max(2e-5, Math.max(...expected) * 0.0008),
          );
        }
      }
    }
  }
});
Deno.test("GGX hemispherical reflectance remains finite and within incident energy", () => {
  for (const metal of [0, 1]) {
    for (const rough of [0.3, 0.6, 1]) {
      for (const view of [[0, 1, 0], [1, 0.2, 0]]) {
        const energy = call("energy", [0.9, 0.6, 0.2, metal, rough, ...view]);
        for (const value of energy) {
          assert(Number.isFinite(value) && value >= 0 && value <= 1.01);
        }
      }
    }
  }
});
Deno.test("point inverse-square falloff, finite range and spot cones", () => {
  for (const distance of [1, 2, 9, 10, 11]) {
    const r = call("light", [
      0,
      distance,
      0,
      10,
      5,
      2,
      10,
      0,
      0,
      0,
      0,
      -1,
      0,
      0.95,
      0.8,
    ]);
    let attenuation = 0;
    if (distance < 10) {
      attenuation = (1 - (distance / 10) ** 4) ** 2 / (distance * distance);
    }
    near(r, [
      0,
      1,
      0,
      10 * attenuation,
      5 * attenuation,
      2 * attenuation,
      10 * attenuation,
      5 * attenuation,
      2 * attenuation,
    ]);
  }
  near(
    call("light", [0, 2, 0, 10, 5, 2, 10, 0, 0, 0, 1, 0, 0, 0.95, 0.8]).slice(
      6,
    ),
    [0, 0, 0],
  );
});
function basis(d: number[]) {
  const [x, y, z] = normalized(d);
  return [
    0.2820947918,
    0.4886025119 * y,
    0.4886025119 * z,
    0.4886025119 * x,
    1.0925484306 * x * y,
    1.0925484306 * y * z,
    0.3153915653 * (3 * z * z - 1),
    1.0925484306 * x * z,
    0.5462742153 * (x * x - y * y),
  ];
}
Deno.test("SH coefficients match host quadrature and constant skies yield pi radiance", () => {
  for (const constant of [true, false]) {
    const directions = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const coefficients = Array.from({ length: 9 }, () => [0, 0, 0]);
    const flat: number[] = [];
    for (let k = 0; k < directions.length; k++) {
      const d = directions[k], radiance = [0.3, 0.6, 0.9];
      if (!constant) {
        radiance[0] *= k + 1;
        radiance[1] *= 2 - k * 0.2;
        radiance[2] *= 0.5 + k * 0.1;
      }
      const weight = 4 * Math.PI / 6;
      flat.push(...d, ...radiance, weight);
      const terms = basis(d);
      for (let i = 0; i < 9; i++) {
        let kernel = Math.PI / 4;
        if (i === 0) kernel = Math.PI;
        if (i >= 1 && i <= 3) kernel = 2 * Math.PI / 3;
        for (let j = 0; j < 3; j++) {
          coefficients[i][j] += radiance[j] * terms[i] * weight * kernel;
        }
      }
    }
    const r = call("sh", flat);
    near(r.slice(0, 27), coefficients.flat());
    const expected = [...directions[2], ...directions[0], ...directions[5]];
    const evaluated: number[] = [];
    for (let k = 0; k < 3; k++) {
      const terms = basis(expected.slice(k * 3, k * 3 + 3));
      for (let j = 0; j < 3; j++) {
        evaluated.push(Math.max(
          0,
          coefficients.reduce((sum, c, i) => sum + c[j] * terms[i], 0),
        ));
      }
    }
    near(r.slice(27), evaluated);
    if (constant) {
      near(
        r.slice(27),
        Array(3).fill([0.3 * Math.PI, 0.6 * Math.PI, 0.9 * Math.PI]).flat(),
      );
    }
  }
});
Deno.test("sky has authored horizon, ground, zenith and solar disk", () => {
  near(call("sky", [1, 0, 0]), [0.3, 0.4, 0.5]);
  near(call("sky", [0, -1, 0]), [0.01, 0.02, 0.03]);
  near(call("sky", [0, 1, 0]), [10.1, 8.2, 6.4]);
});
Deno.test("cascade practical splits match linear and logarithmic references", () => {
  for (const blend of [0, 0.5, 1]) {
    for (const count of [1, 4, 8]) {
      const expected = Array.from({ length: count }, (_, i) => {
        const t = (i + 1) / count;
        return (0.1 + (1000 - 0.1) * t) * (1 - blend) +
          (0.1 * (1000 / 0.1) ** t) * blend;
      });
      near(call("splits", [0.1, 1000, count, blend]), expected, 0.005);
    }
  }
  assertEquals(call("splits", [0.1, 1000, 4, 0.5]).at(-1), 1000);
  const extreme = call("splits", [1e-30, 1e30, 4, 1]);
  for (const value of extreme) assert(Number.isFinite(value) && value > 0);
  assertEquals(call("splits", [0, 100, 4, 0.5]), []);
  assertEquals(call("splits", [1, 100, 0, 0.5]), []);
});
Deno.test("shadow fitting contains corners, pads depth and snaps subtexel pans", () => {
  const corners: number[][] = [];
  for (const x of [-2, 2]) {
    for (const y of [-1, 1]) {
      for (const z of [-4, -1]) corners.push([x, y, z]);
    }
  }
  const axial = call("cascade", [0, 0, -1, 1024, 3, ...corners.flat()]);
  const radius = Math.ceil(Math.sqrt(2 ** 2 + 1 ** 2 + 1.5 ** 2) * 16) / 16 /
    (1 - 1 / 1024);
  near(axial.slice(0, 11), [
    0,
    0,
    -2.5 + radius + 3,
    0,
    0,
    0,
    1,
    radius * 2,
    1,
    0,
    (radius + 3) * 2,
  ]);
  for (let i = 0; i < corners.length; i++) {
    const [x, y, z] = corners[i];
    near(axial.slice(11 + i * 3, 14 + i * 3), [
      x / radius,
      y / radius,
      (-z - 2.5 + radius + 3) / ((radius + 3) * 2),
    ]);
  }
  assertEquals(call("cascade", [0, 0, 0, 1024, 0, ...corners.flat()]), []);
  assertEquals(call("cascade", [0, 0, -1, 1, 0, ...corners.flat()]), []);
  const base = call("cascade", [0, -1, -1, 1024, 3, ...corners.flat()]);
  for (let i = 11; i < base.length; i += 3) {
    assert(Math.abs(base[i]) <= 1);
    assert(Math.abs(base[i + 1]) <= 1);
    assert(base[i + 2] >= 0 && base[i + 2] <= 1);
  }
  const shifted = call("cascade", [
    0,
    -1,
    -1,
    1024,
    3,
    ...corners.flatMap((p) => [p[0] + 0.0001, p[1], p[2]]),
  ]);
  near(shifted.slice(0, 11), base.slice(0, 11));
  const tight = call("cascade", [
    0,
    0,
    -1,
    1024,
    0,
    1.0009,
    0,
    0,
    -0.9991,
    0,
    0,
  ]);
  for (let i = 11; i < tight.length; i += 3) {
    assert(Math.abs(tight[i]) <= 1, `snapping clipped x=${tight[i]}`);
  }
});
Deno.test.afterAll(async () => await fixture.dispose());
