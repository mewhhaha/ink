import { compile } from "./support.ts";

/** All input rows are rounded to F32 before either oracle runs. */
export interface NumericRow {
  inputs: number[];
  actual: number[];
  expected: number[];
}
export interface NumericCorpus {
  color: NumericRow[];
  brdf: NumericRow[];
  projection: NumericRow[];
  splits: NumericRow[];
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
  return Math.min(1, x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14));
}
function normalize(v: number[]) {
  const size = Math.hypot(...v);
  return v.map((x) => x / size);
}
function dot(a: number[], b: number[]) {
  return a.reduce((sum, x, i) => sum + x * b[i], 0);
}
// Independent double-precision GGX reference; no shader helper is an oracle.
function brdf(a: number[]) {
  const n = normalize(a.slice(5, 8));
  const v = normalize(a.slice(8, 11));
  const l = normalize(a.slice(11, 14));
  const nl = Math.max(0, Math.min(1, dot(n, l)));
  const nv = Math.max(1e-5, dot(n, v));
  if (nl <= 0 || dot(n, v) <= 0) return [0, 0, 0];
  const h = normalize(v.map((x, i) => x + l[i]));
  const nh = Math.max(0, Math.min(1, dot(n, h)));
  const vh = Math.max(0, Math.min(1, dot(v, h)));
  const alpha2 = Math.max(0.04, Math.min(1, a[4])) ** 4;
  const denominator = nh * nh * (alpha2 - 1) + 1;
  const distribution = alpha2 / (Math.PI * denominator * denominator);
  const visibility = 0.5 /
    Math.max(
      1e-6,
      nl * Math.sqrt(nv * nv * (1 - alpha2) + alpha2) +
        nv * Math.sqrt(nl * nl * (1 - alpha2) + alpha2),
    );
  const metal = Math.max(0, Math.min(1, a[3]));
  return a.slice(0, 3).map((base) => {
    const f0 = 0.04 + (base - 0.04) * metal;
    const fresnel = f0 + (1 - f0) * (1 - vh) ** 5;
    return ((1 - fresnel) * base * (1 - metal) / Math.PI +
      fresnel * distribution * visibility) * nl;
  });
}
function projection(a: number[]) {
  const [height, aspect, near, far, reversed, orthographic, x, y, z] = a;
  let sy = 1 / Math.tan(height / 2), depthA = far / (near - far);
  let depthB = near * depthA, w = -z;
  let matrixW = -1, matrixEnd = 0;
  if (orthographic) {
    sy = 2 / height;
    depthA = 1 / (near - far);
    depthB = near * depthA;
    w = 1;
    matrixW = 0;
    matrixEnd = 1;
  }
  if (reversed) {
    depthA = -depthA + matrixW;
    depthB = -depthB + matrixEnd;
  }
  const sx = sy / aspect;
  return [
    x * sx / w,
    y * sy / w,
    (z * depthA + depthB) / w,
    sx,
    0,
    0,
    0,
    0,
    sy,
    0,
    0,
    0,
    0,
    depthA,
    matrixW,
    0,
    0,
    depthB,
    matrixEnd,
  ];
}
/** Fixed seed, endpoint witnesses, and bounded randomized interior rows. */
export async function numericCorpus(): Promise<NumericCorpus> {
  const fixture = await compile(
    new URL("./numeric-corpus.blot", import.meta.url),
  );
  const corpus: NumericCorpus = {
    color: [],
    brdf: [],
    projection: [],
    splits: [],
  };
  let seed = 0x1a2b3c4d;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 8) / 16777216;
  };
  function row(
    name: string,
    inputs: number[],
    oracle: (a: number[]) => number[],
  ) {
    inputs = inputs.map(Math.fround);
    return {
      inputs,
      actual: Array.from(
        fixture.guest.call(name, new Float32Array(inputs)) as Float32Array,
      ),
      expected: oracle(inputs),
    };
  }
  try {
    for (const value of [-0.1, 0, 0.0031308, 0.04045, 0.18, 1, 4, 64]) {
      corpus.color.push(
        row(
          "colors",
          [value, 1.5],
          (
            a,
          ) => [
            linear(a[0]),
            srgb(a[0]),
            tone(a[0]),
            srgb(tone(a[0] * 2 ** a[1])),
          ],
        ),
      );
    }
    for (let i = 0; i < 24; i++) {
      corpus.color.push(
        row(
          "colors",
          [random() * 8, random() * 8 - 4],
          (
            a,
          ) => [
            linear(a[0]),
            srgb(a[0]),
            tone(a[0]),
            srgb(tone(a[0] * 2 ** a[1])),
          ],
        ),
      );
      corpus.brdf.push(
        row("brdf", [
          random(),
          random(),
          random(),
          random(),
          0.1 + random() * 0.9,
          0,
          1,
          0,
          random() * 2 - 1,
          0.01 + random(),
          random() * 2 - 1,
          random() * 2 - 1,
          0.01 + random(),
          random() * 2 - 1,
        ], brdf),
      );
    }
    for (const metal of [0, 1]) {
      for (const rough of [0.04, 0.5, 1]) {
        for (const light of [[0, 1, 0], [1, 0.001, 0], [0, -1, 0]]) {
          corpus.brdf.push(
            row("brdf", [
              0.8,
              0.3,
              0.05,
              metal,
              rough,
              0,
              1,
              0,
              0,
              1,
              0,
              ...light,
            ], brdf),
          );
        }
      }
    }
    for (const ortho of [0, 1]) {
      for (const reversed of [0, 1]) {
        for (const z of [-0.2, -4, -200]) {
          corpus.projection.push(
            row("projection", [
              1.3,
              1.7,
              0.2,
              200,
              reversed,
              ortho,
              0.5,
              -0.4,
              z,
            ], projection),
          );
        }
      }
    }
    for (const blend of [0, 0.5, 1]) {
      for (const count of [1, 4, 8]) {
        corpus.splits.push(
          row(
            "splits",
            [0.1, 1000, count, blend],
            (a) =>
              Array.from({ length: a[2] }, (_, i) => {
                const t = (i + 1) / a[2];
                return (a[0] + (a[1] - a[0]) * t) * (1 - a[3]) +
                  a[0] * (a[1] / a[0]) ** t * a[3];
              }),
          ),
        );
      }
    }
    return corpus;
  } finally {
    await fixture.dispose();
  }
}
