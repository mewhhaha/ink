/**
 * The scatter meshes: a pine, an oak, a rock and a grass tuft, written as
 * single-primitive binary glTF files into assets/scatter/. The look is carried
 * by COLOR_0 vertex colours (no textures); trees stand on the ground at the
 * origin, +Y up, metres. The pine, oak and rock are dense enough for the
 * importer to build detail levels (3,000+ triangles per primitive), the rock
 * and the grass are cheap.
 *
 *   deno run -A examples/terrain/scripts/meshes.ts
 */
import { noise } from "@ink/geometry";
import { clamp, mix, rng, smoothstep } from "./world.ts";

type Vec3 = [number, number, number];
type Rgb = [number, number, number];

// Builder --------------------------------------------------------------------------

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Linear RGBA. */
  colors: Float32Array;
  indices: Uint32Array;
}

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

class Builder {
  positions: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  indices: number[] = [];

  /** Add a vertex; `color` is sRGB 0..1 and stored linear, as glTF wants. */
  vertex(p: Vec3, uv: [number, number], color: Rgb): number {
    this.positions.push(p[0], p[1], p[2]);
    this.uvs.push(uv[0], uv[1]);
    this.colors.push(
      srgbToLinear(clamp(color[0])),
      srgbToLinear(clamp(color[1])),
      srgbToLinear(clamp(color[2])),
      1,
    );
    return this.positions.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) {
    this.indices.push(a, b, c);
  }

  /**
   * A surface of revolution style grid: `rings` rings of `segments` vertices.
   * Triangles face outward when `point(i, a)` walks ring points counter
   * clockwise seen from the end the next ring lies towards. Optional
   * `start` and `end` points close it with fans.
   */
  surface(
    rings: number,
    segments: number,
    point: (ring: number, angle: number) => Vec3,
    color: (ring: number, angle: number, p: Vec3) => Rgb,
    caps: { start?: [Vec3, Rgb]; end?: [Vec3, Rgb] } = {},
  ) {
    const first = this.positions.length / 3;
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segments; j++) {
        const a = j / segments * Math.PI * 2;
        const p = point(i, a);
        this.vertex(
          p,
          [j / segments, i / Math.max(1, rings - 1)],
          color(i, a, p),
        );
      }
    }
    const at = (i: number, j: number) => first + i * segments + (j % segments);
    for (let i = 0; i + 1 < rings; i++) {
      for (let j = 0; j < segments; j++) {
        const p00 = at(i, j), p10 = at(i, j + 1);
        const p01 = at(i + 1, j), p11 = at(i + 1, j + 1);
        this.tri(p00, p01, p10);
        this.tri(p10, p01, p11);
      }
    }
    if (caps.start) {
      const centre = this.vertex(caps.start[0], [0.5, 0], caps.start[1]);
      for (let j = 0; j < segments; j++) {
        this.tri(centre, at(0, j), at(0, j + 1));
      }
    }
    if (caps.end) {
      const centre = this.vertex(caps.end[0], [0.5, 1], caps.end[1]);
      for (let j = 0; j < segments; j++) {
        this.tri(at(rings - 1, j + 1), at(rings - 1, j), centre);
      }
    }
  }

  /** Smooth area-weighted normals over the shared vertices. */
  finish(): MeshData {
    const positions = Float32Array.from(this.positions);
    const indices = Uint32Array.from(this.indices);
    return {
      positions,
      normals: smoothNormals(positions, indices),
      uvs: Float32Array.from(this.uvs),
      colors: Float32Array.from(this.colors),
      indices,
    };
  }
}

function smoothNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      normals[o] += nx;
      normals[o + 1] += ny;
      normals[o + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l;
    normals[i + 1] /= l;
    normals[i + 2] /= l;
  }
  return normals;
}

const lerpRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
];
const scaleRgb = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];
const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const lump = (x: number, y: number, z: number, seed: number) =>
  noise.perlin3(x, y, z, seed);

/** A tube along a path whose radius changes; `wobble` perturbs the radius. */
function tube(
  b: Builder,
  path: Vec3[],
  radii: number[],
  segments: number,
  color: (ring: number, angle: number, p: Vec3) => Rgb,
  wobble: (ring: number, angle: number) => number = () => 1,
  caps: { start?: Rgb; end?: Rgb } = {},
) {
  // Parallel-transported frames: rings do not twist along a curved path.
  const tangents = path.map((_, i): Vec3 => {
    const next = path[Math.min(path.length - 1, i + 1)];
    const prev = path[Math.max(0, i - 1)];
    return normalize([next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]]);
  });
  const frames: { t: Vec3; n: Vec3; b: Vec3 }[] = [];
  let n: Vec3 = normalize(
    cross(Math.abs(tangents[0][1]) < 0.95 ? [0, 1, 0] : [1, 0, 0], tangents[0]),
  );
  for (const t of tangents) {
    const along = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
    n = normalize([
      n[0] - t[0] * along,
      n[1] - t[1] * along,
      n[2] - t[2] * along,
    ]);
    frames.push({ t, n, b: cross(n, t) });
  }
  const ringPoint = (i: number, a: number): Vec3 => {
    const f = frames[i], r = radii[i] * wobble(i, a);
    const c = Math.cos(a) * r, s = Math.sin(a) * r;
    return [
      path[i][0] + f.n[0] * c + f.b[0] * s,
      path[i][1] + f.n[1] * c + f.b[1] * s,
      path[i][2] + f.n[2] * c + f.b[2] * s,
    ];
  };
  const last = path.length - 1;
  b.surface(
    path.length,
    segments,
    ringPoint,
    color,
    {
      start: caps.start ? [path[0], caps.start] : undefined,
      end: caps.end ? [path[last], caps.end] : undefined,
    },
  );
}

// Pine -------------------------------------------------------------------------------

export function pine(): MeshData {
  const b = new Builder();
  const random = rng(7001);
  const bark: Rgb = [0.24, 0.15, 0.09];

  // Trunk, flaring at the foot and leaning a little.
  const rings = 10;
  const trunk: Vec3[] = [];
  const radii: number[] = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1), y = -0.15 + 15.2 * t;
    trunk.push([0.35 * t * t, y, -0.2 * t * t]);
    radii.push(0.5 * (1 - 0.72 * t) * (1 + 0.7 * Math.exp(-y * 1.1)));
  }
  tube(
    b,
    trunk,
    radii,
    14,
    (i, a) => scaleRgb(bark, 0.8 + 0.35 * lump(a * 2, i * 0.7, 1, 5)),
    (_, a) => 1 + 0.08 * Math.sin(a * 5 + 1) + 0.06 * Math.sin(a * 9),
    { start: [0.15, 0.1, 0.06] },
  );

  // Five tiers of needles, each a drooping cone with an uneven rim.
  const tiers = [
    { y: 1.9, r: 3.7, h: 5.4 },
    { y: 4.5, r: 3.1, h: 4.9 },
    { y: 7.0, r: 2.5, h: 4.5 },
    { y: 9.4, r: 1.9, h: 4.0 },
    { y: 11.6, r: 1.3, h: 3.7 },
  ];
  tiers.forEach((tier, k) => {
    const phase = random() * 6.28, lean = 0.06 * k;
    const tone = 0.9 + 0.2 * random();
    const deep: Rgb = [0.07, 0.18, 0.09], tip: Rgb = [0.2, 0.4, 0.16];
    const spread = (a: number, t: number) =>
      1 + 0.2 * lump(Math.cos(a) * 1.4 + k, Math.sin(a) * 1.4, t * 1.5, 11) +
      0.1 * Math.sin(a * 11 + phase) * (1 - t) +
      0.05 * Math.sin(a * 23 + phase * 2);
    const R = 8;
    const apex: Vec3 = [lean, tier.y + tier.h, -lean * 0.5];
    b.surface(
      R,
      48,
      (i, a) => {
        const t = i / R;
        const m = spread(a, t);
        const radius = tier.r * Math.pow(1 - t, 0.9) * m;
        // Branch tips droop below the tier's base line.
        const droop = 0.9 * (m - 0.7) * (1 - t) * (1 - t) * tier.r * 0.25;
        return [
          Math.cos(a) * radius + lean * t,
          tier.y + tier.h * t - droop,
          Math.sin(a) * radius - lean * 0.5 * t,
        ];
      },
      (i, a, p) => {
        const t = i / R;
        const patch = 0.5 + 0.5 * lump(p[0] * 0.9, p[1] * 0.9, p[2] * 0.9, 17);
        const c = lerpRgb(deep, tip, Math.pow(t, 0.7) * 0.6 + patch * 0.4);
        return scaleRgb(c, tone * (0.8 + 0.4 * spread(a, t) - 0.2));
      },
      {
        start: [[0, tier.y + 0.5, 0], [0.04, 0.09, 0.05]],
        end: [apex, [0.2, 0.4, 0.17]],
      },
    );
  });
  return b.finish();
}

// Oak --------------------------------------------------------------------------------

export function oak(): MeshData {
  const b = new Builder();
  const bark: Rgb = [0.25, 0.18, 0.12];
  const barkColor = (i: number, a: number): Rgb =>
    scaleRgb(bark, 0.75 + 0.4 * (0.5 + 0.5 * lump(a * 1.6, i * 0.5, 3, 23)));

  // Trunk: a short, thick, slightly bent stem with buttress roots.
  const rings = 12;
  const stem: Vec3[] = [];
  const stemRadii: number[] = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1), y = 0.05 + 4.4 * t;
    stem.push([0.45 * Math.sin(t * 2.2), y, 0.25 * t * t]);
    stemRadii.push(0.62 * (1 - 0.4 * t) * (1 + 0.9 * Math.exp(-y * 1.3)));
  }
  tube(
    b,
    stem,
    stemRadii,
    14,
    (i, a) => barkColor(i, a),
    (_, a) => 1 + 0.12 * Math.sin(a * 4 + 0.5) + 0.07 * Math.sin(a * 7),
    { start: [0.12, 0.08, 0.05] },
  );

  // Branches fork from the top of the stem towards the crown's lobes.
  const top = stem[stem.length - 1];
  const forks: Vec3[] = [
    [3.6, 7.2, 1.2],
    [-3.2, 7.6, 2.4],
    [0.8, 8.0, -3.8],
    [-1.2, 9.0, 0.6],
    [2.6, 8.8, 3.0],
  ];
  forks.forEach((end, k) => {
    const path: Vec3[] = [];
    const radii: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      path.push([
        mix(top[0], end[0], t) + 0.3 * Math.sin(t * 3 + k),
        mix(top[1] - 0.2, end[1], Math.pow(t, 0.85)),
        mix(top[2], end[2], t) + 0.3 * Math.cos(t * 3 + k),
      ]);
      radii.push(0.3 * (1 - 0.7 * t));
    }
    tube(b, path, radii, 8, (i, a) => barkColor(i, a), () => 1, {
      end: [0.2, 0.14, 0.09],
    });
  });

  // The crown: overlapping lumpy blobs, lighter on top and darker inside.
  const centre: Vec3 = [0, 8.6, 0.4];
  const blobs: { c: Vec3; r: Vec3 }[] = [
    { c: [0, 9.4, 0.3], r: [4.4, 3.4, 4.4] },
    { c: [3.5, 7.9, 1.4], r: [3.5, 2.8, 3.3] },
    { c: [-3.3, 8.1, 2.4], r: [3.4, 2.9, 3.4] },
    { c: [0.8, 8.2, -3.6], r: [3.6, 2.8, 3.2] },
    { c: [-1.6, 11.0, -0.6], r: [3.0, 2.4, 3.0] },
    { c: [2.2, 10.8, 2.2], r: [2.8, 2.3, 2.8] },
    { c: [-3.0, 6.9, -1.6], r: [2.6, 2.1, 2.6] },
  ];
  blobs.forEach((blob, k) => {
    const tone: Rgb = lerpRgb(
      [0.1, 0.27, 0.06],
      [0.16, 0.33, 0.07],
      (k % 3) / 2,
    );
    const shade: Rgb = [0.05, 0.13, 0.04], light: Rgb = [0.34, 0.5, 0.12];
    const R = 11, S = 24;
    const direction = (i: number, a: number): Vec3 => {
      const theta = Math.PI * (i + 1) / R;
      return [
        Math.sin(theta) * Math.cos(a),
        -Math.cos(theta),
        Math.sin(theta) * Math.sin(a),
      ];
    };
    const displace = (d: Vec3) =>
      1 + 0.16 * lump(d[0] * 1.3 + k * 7, d[1] * 1.3, d[2] * 1.3, 31) +
      0.08 * lump(d[0] * 3.1 + k, d[1] * 3.1, d[2] * 3.1, 37);
    const place = (d: Vec3): Vec3 => {
      const m = displace(d);
      return [
        blob.c[0] + d[0] * blob.r[0] * m,
        blob.c[1] + d[1] * blob.r[1] * m,
        blob.c[2] + d[2] * blob.r[2] * m,
      ];
    };
    const paint = (p: Vec3, d: Vec3): Rgb => {
      const up = clamp(0.5 + 0.55 * d[1]);
      const leafy = 0.5 + 0.5 * lump(p[0] * 0.8, p[1] * 0.8, p[2] * 0.8, 41);
      const inner = clamp(
        Math.hypot(p[0] - centre[0], p[1] - centre[1] - 1, p[2] - centre[2]) /
          5.5,
      );
      const c = lerpRgb(
        shade,
        light,
        smoothstep(0.1, 1, up) * 0.75 + leafy * 0.25,
      );
      return scaleRgb(lerpRgb(c, tone, 0.35), 0.55 + 0.6 * inner);
    };
    b.surface(
      R - 1,
      S,
      (i, a) => place(direction(i, a)),
      (i, a, p) => paint(p, direction(i, a)),
      {
        start: [place([0, -1, 0]), paint(place([0, -1, 0]), [0, -1, 0])],
        end: [place([0, 1, 0]), paint(place([0, 1, 0]), [0, 1, 0])],
      },
    );
  });
  return b.finish();
}

// Rock -------------------------------------------------------------------------------

/** A flat-shaded geodesic sphere (20 * frequency² triangles) pushed into a
 * chunky boulder with cut facets. */
export function rock(frequency = 9): MeshData {
  const positions: number[] = [], colors: number[] = [], uvs: number[] = [];
  const t = (1 + Math.sqrt(5)) / 2;
  const corners: Vec3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((v) => normalize(v as Vec3));
  const faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  // Cutting planes give the stone its flat faces.
  const random = rng(7003);
  const planes = Array.from({ length: 9 }, () => {
    const n = normalize([
      random() - 0.5,
      random() * 0.9 - 0.45,
      random() - 0.5,
    ]);
    return { n, d: 0.62 + 0.2 * random() };
  });
  const shape = (d: Vec3): Vec3 => {
    const lumps = 1 + 0.2 * lump(d[0] * 1.1, d[1] * 1.1, d[2] * 1.1, 51) +
      0.07 * lump(d[0] * 3, d[1] * 3, d[2] * 3, 53);
    let p: Vec3 = [
      d[0] * 1.05 * lumps,
      d[1] * 0.78 * lumps,
      d[2] * 0.9 * lumps,
    ];
    for (const plane of planes) {
      const over = p[0] * plane.n[0] + p[1] * plane.n[1] + p[2] * plane.n[2] -
        plane.d;
      if (over > 0) {
        p = [
          p[0] - plane.n[0] * over,
          p[1] - plane.n[1] * over,
          p[2] - plane.n[2] * over,
        ];
      }
    }
    // Sits on the ground with a flat, slightly buried bottom.
    return [p[0], Math.max(p[1], -0.62) + 0.58, p[2]];
  };
  const stone: Rgb = [0.4, 0.38, 0.35], warm: Rgb = [0.5, 0.43, 0.35];
  const moss: Rgb = [0.24, 0.32, 0.14];
  const f = frequency;
  const point = (face: number[], i: number, j: number): Vec3 => {
    const a = corners[face[0]], b = corners[face[1]], c = corners[face[2]];
    const u = i / f, v = j / f, w = 1 - u - v;
    return normalize([
      a[0] * w + b[0] * u + c[0] * v,
      a[1] * w + b[1] * u + c[1] * v,
      a[2] * w + b[2] * u + c[2] * v,
    ]);
  };
  const emit = (d: Vec3[]) => {
    const p = d.map(shape);
    const n = normalize(cross(
      [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]],
      [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]],
    ));
    const centre: Vec3 = [
      (p[0][0] + p[1][0] + p[2][0]) / 3,
      (p[0][1] + p[1][1] + p[2][1]) / 3,
      (p[0][2] + p[1][2] + p[2][2]) / 3,
    ];
    // Per facet colour: stone and warm bands, mossy on top, dark below.
    const band = 0.5 +
      0.5 * lump(centre[0] * 2.2, centre[1] * 2.2, centre[2] * 2.2, 57);
    let c = lerpRgb(stone, warm, band);
    c = lerpRgb(c, moss, smoothstep(0.55, 0.9, n[1]) * (0.35 + 0.4 * band));
    c = scaleRgb(
      c,
      (0.62 + 0.5 * smoothstep(0, 0.9, centre[1])) *
        (0.92 + 0.16 * lump(centre[0] * 9, centre[1] * 9, centre[2] * 9, 59)),
    );
    for (let k = 0; k < 3; k++) {
      positions.push(p[k][0], p[k][1], p[k][2]);
      colors.push(
        srgbToLinear(clamp(c[0])),
        srgbToLinear(clamp(c[1])),
        srgbToLinear(clamp(c[2])),
        1,
      );
      uvs.push(p[k][0] * 0.5 + 0.5, p[k][2] * 0.5 + 0.5);
    }
  };
  for (const face of faces) {
    for (let j = 0; j < f; j++) {
      for (let i = 0; i < f - j; i++) {
        emit([point(face, i, j), point(face, i + 1, j), point(face, i, j + 1)]);
        if (i + j < f - 1) {
          emit([
            point(face, i + 1, j),
            point(face, i + 1, j + 1),
            point(face, i, j + 1),
          ]);
        }
      }
    }
  }
  const count = positions.length / 3;
  const pos = Float32Array.from(positions);
  const indices = Uint32Array.from({ length: count }, (_, i) => i);
  // Flat shading: each triangle owns its three vertices.
  return {
    positions: pos,
    normals: smoothNormals(pos, indices),
    uvs: Float32Array.from(uvs),
    colors: Float32Array.from(colors),
    indices,
  };
}

// Grass ------------------------------------------------------------------------------

/** A tuft of bent blades, 63 triangles. */
export function grass(): MeshData {
  const b = new Builder();
  const random = rng(7004);
  const blades = 7, rows = 5;
  for (let k = 0; k < blades; k++) {
    const around = k / blades * Math.PI * 2 + random() * 0.6;
    const root = 0.07 + 0.09 * random();
    const base: Vec3 = [Math.cos(around) * root, 0, Math.sin(around) * root];
    const lean = around + (random() - 0.5) * 0.9;
    const height = 0.55 + 0.4 * random() + (k === 0 ? 0.15 : 0);
    const bend = 0.18 + 0.35 * random();
    const width = 0.065 + 0.03 * random();
    const tone = 0.85 + 0.3 * random();
    const facing = random() * Math.PI;
    const side: Vec3 = [Math.cos(facing), 0, Math.sin(facing)];
    const dark: Rgb = [0.05, 0.12, 0.03], light: Rgb = [0.4, 0.58, 0.14];
    const first = b.positions.length / 3;
    const place = (t: number): Vec3 => [
      base[0] + Math.cos(lean) * bend * t * t * height,
      height * t * (1 - 0.12 * t),
      base[2] + Math.sin(lean) * bend * t * t * height,
    ];
    const paint = (t: number): Rgb =>
      scaleRgb(lerpRgb(dark, light, Math.pow(t, 0.8)), tone);
    for (let i = 0; i < rows; i++) {
      const t = i / rows, p = place(t), w = width * (1 - 0.8 * t * t);
      b.vertex(
        [p[0] - side[0] * w, p[1], p[2] - side[2] * w],
        [0, t],
        paint(t),
      );
      b.vertex(
        [p[0] + side[0] * w, p[1], p[2] + side[2] * w],
        [1, t],
        paint(t),
      );
    }
    const tip = b.vertex(place(1), [0.5, 1], paint(1));
    for (let i = 0; i + 1 < rows; i++) {
      const l0 = first + i * 2, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
      b.tri(l0, r0, l1);
      b.tri(r0, r1, l1);
    }
    const l = first + (rows - 1) * 2;
    b.tri(l, l + 1, tip);
  }
  const mesh = b.finish();
  // Blades are lit softly: normals lean towards up, whichever way they face.
  for (let i = 0; i < mesh.normals.length; i += 3) {
    const n = normalize([
      mesh.normals[i] * 0.45,
      Math.abs(mesh.normals[i + 1]) * 0.45 + 0.75,
      mesh.normals[i + 2] * 0.45,
    ]);
    mesh.normals.set(n, i);
  }
  return mesh;
}

// glTF -------------------------------------------------------------------------------

/** Encode one mesh as a GLB: one node, one mesh, one primitive, one material. */
export function toGlb(
  name: string,
  mesh: MeshData,
  material: { roughness: number; doubleSided?: boolean },
): Uint8Array {
  const wide = mesh.positions.length / 3 > 65535;
  const indexBytes = wide
    ? new Uint8Array(mesh.indices.buffer)
    : new Uint8Array(Uint16Array.from(mesh.indices).buffer);
  const streams: { data: Uint8Array; target: number }[] = [
    { data: new Uint8Array(mesh.positions.buffer), target: 34962 },
    { data: new Uint8Array(mesh.normals.buffer), target: 34962 },
    { data: new Uint8Array(mesh.uvs.buffer), target: 34962 },
    { data: new Uint8Array(mesh.colors.buffer), target: 34962 },
    { data: indexBytes, target: 34963 },
  ];
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], mesh.positions[i]);
    max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
  }
  const count = mesh.positions.length / 3;
  let length = 0;
  const bufferViews = streams.map((s) => {
    const view = {
      buffer: 0,
      byteOffset: length,
      byteLength: s.data.length,
      target: s.target,
    };
    length += Math.ceil(s.data.length / 4) * 4;
    return view;
  });
  const json = {
    asset: {
      version: "2.0",
      generator: "ink examples/terrain/scripts/meshes.ts",
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{
      name,
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, COLOR_0: 3 },
        indices: 4,
        material: 0,
      }],
    }],
    materials: [{
      name: `${name} vertex colour`,
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: material.roughness,
      },
      doubleSided: material.doubleSided ?? false,
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count, type: "VEC2" },
      { bufferView: 3, componentType: 5126, count, type: "VEC4" },
      {
        bufferView: 4,
        componentType: wide ? 5125 : 5123,
        count: mesh.indices.length,
        type: "SCALAR",
      },
    ],
    bufferViews,
    buffers: [{ byteLength: length }],
  };
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + length;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(text, 20);
  glb.fill(0x20, 20 + text.length, 20 + jsonLength);
  let at = 20 + jsonLength;
  view.setUint32(at, length, true);
  view.setUint32(at + 4, 0x004e4942, true);
  at += 8;
  streams.forEach((s, i) => glb.set(s.data, at + bufferViews[i].byteOffset));
  return glb;
}

export interface GeneratedMesh {
  file: string;
  glb: Uint8Array;
  triangles: number;
  vertices: number;
}

/** Every mesh, by file name. */
export function generateMeshes(): GeneratedMesh[] {
  const make = (
    file: string,
    mesh: MeshData,
    material: { roughness: number; doubleSided?: boolean },
  ) => ({
    file,
    glb: toGlb(file.replace(/\.glb$/, ""), mesh, material),
    triangles: mesh.indices.length / 3,
    vertices: mesh.positions.length / 3,
  });
  return [
    make("pine.glb", pine(), { roughness: 0.9 }),
    make("oak.glb", oak(), { roughness: 0.9 }),
    make("rock.glb", rock(), { roughness: 0.92 }),
    make("grass.glb", grass(), { roughness: 0.8, doubleSided: true }),
  ];
}

export async function writeMeshes() {
  const started = performance.now();
  const dir = new URL("../assets/scatter/", import.meta.url);
  await Deno.mkdir(dir, { recursive: true });
  for (const mesh of generateMeshes()) {
    await Deno.writeFile(new URL(mesh.file, dir), mesh.glb);
    console.log(
      `${mesh.file}: ${mesh.triangles.toLocaleString()} triangles, ${mesh.vertices.toLocaleString()} vertices, ${
        (mesh.glb.length / 1e3).toFixed(0)
      } kB`,
    );
  }
  console.log(`meshes: ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

if (import.meta.main) await writeMeshes();
