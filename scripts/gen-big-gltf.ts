/**
 * Writes a large, reproducible glTF binary for the asset pipeline gate: a
 * displaced terrain of about 1.3 million triangles and three smaller props,
 * four materials, and PBR textures that are mostly incompressible noise (so
 * the PNGs stay large). Everything derives from a fixed seed: running it
 * twice gives byte-identical files.
 *
 *   deno run -A scripts/gen-big-gltf.ts [out.glb] [--grid 800] [--texture 2048]
 *
 * The default output is `tmp/big-scene.glb` (about 50 MB, git-ignored).
 */
import { encode } from "fast-png";

const args = Deno.args.filter((a) => !a.startsWith("--"));
const flag = (name: string, fallback: number) => {
  const at = Deno.args.indexOf(`--${name}`);
  return at >= 0 ? Number(Deno.args[at + 1]) : fallback;
};
const out = args[0] ?? "tmp/big-scene.glb";
const GRID = flag("grid", 600);
const TEX = flag("texture", 2048);

// Deterministic random numbers (mulberry32).
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lattice = (() => {
  const r = rng(7);
  const table = new Float32Array(256 * 256);
  for (let i = 0; i < table.length; i++) table[i] = r();
  return table;
})();
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const at = (a: number, b: number) => lattice[((b & 255) << 8) | (a & 255)];
  const top = at(xi, yi) * (1 - u) + at(xi + 1, yi) * u;
  const bottom = at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u;
  return top * (1 - v) + bottom * v;
}
function fbm(x: number, y: number, octaves: number): number {
  let sum = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f, y * f) * amp;
    f *= 2;
    amp *= 0.5;
  }
  return sum;
}
const height = (u: number, v: number) =>
  (fbm(u * 6, v * 6, 6) - 0.45) * 0.55 +
  Math.sin(u * 9) * Math.cos(v * 7) * 0.05;

// Terrain -----------------------------------------------------------------------
function terrain(n: number) {
  const verts = (n + 1) * (n + 1);
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  const size = 40;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const u = i / n, v = j / n;
      const o = j * (n + 1) + i;
      const h = height(u, v);
      positions.set([(u - 0.5) * size, h * 6, (v - 0.5) * size], o * 3);
      const e = 1 / n;
      const dx = (height(u + e, v) - height(u - e, v)) * 6 / (2 * e * size);
      const dz = (height(u, v + e) - height(u, v - e)) * 6 / (2 * e * size);
      const l = Math.hypot(dx, 1, dz);
      normals.set([-dx / l, 1 / l, -dz / l], o * 3);
      uvs.set([u * 8, v * 8], o * 2);
    }
  }
  const indices = new Uint32Array(n * n * 6);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      indices.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }
  return { positions, normals, uvs, indices };
}

function sphere(rings: number, segments: number, radius: number, at: number[]) {
  const verts = (rings + 1) * (segments + 1);
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  for (let r = 0; r <= rings; r++) {
    for (let s = 0; s <= segments; s++) {
      const phi = Math.PI * r / rings, theta = 2 * Math.PI * s / segments;
      const n = [
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ];
      const o = r * (segments + 1) + s;
      normals.set(n, o * 3);
      positions.set(n.map((x, a) => x * radius + at[a]), o * 3);
      uvs.set([s / segments, r / rings], o * 2);
    }
  }
  const indices = new Uint32Array(rings * segments * 6);
  let k = 0;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + 1,
        c = a + segments + 1,
        d = c + 1;
      indices.set([a, b, c, b, d, c], k);
      k += 6;
    }
  }
  return { positions, normals, uvs, indices };
}

// Textures ----------------------------------------------------------------------
function png(
  size: number,
  pixel: (x: number, y: number, r: () => number) => number[],
  seed: number,
) {
  const r = rng(seed);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      data.set(pixel(x / size, y / size, r), (y * size + x) * 4);
    }
  }
  return encode({ width: size, height: size, data, channels: 4, depth: 8 });
}
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const rock = png(TEX, (u, v, r) => {
  const n = fbm(u * 24, v * 24, 6), grain = (r() - 0.5) * 70;
  const band = Math.sin((u + n) * 60) * 14;
  return [
    clamp(95 + n * 120 + band + grain),
    clamp(88 + n * 100 + band + grain),
    clamp(78 + n * 90 + grain),
    255,
  ];
}, 11);
const normalMap = png(TEX, (u, v, r) => {
  const e = 1 / TEX;
  const h = (a: number, b: number) =>
    fbm(a * 24, b * 24, 6) * 6 + (r() - 0.5) * 0.6;
  const dx = (h(u + e, v) - h(u - e, v)) * 3,
    dy = (h(u, v + e) - h(u, v - e)) * 3;
  const l = Math.hypot(dx, dy, 1);
  return [
    clamp((-dx / l * 0.5 + 0.5) * 255),
    clamp((-dy / l * 0.5 + 0.5) * 255),
    clamp((1 / l * 0.5 + 0.5) * 255),
    255,
  ];
}, 12);
const orm = png(TEX / 2, (u, v, r) => {
  const n = fbm(u * 12, v * 12, 5);
  return [
    clamp(200 + (r() - 0.5) * 50),
    clamp(120 + n * 130 + (r() - 0.5) * 40),
    clamp(20 + n * 30),
    255,
  ];
}, 13);
const moss = png(TEX / 2, (u, v, r) => {
  const n = fbm(u * 16, v * 16, 5);
  return [
    clamp(40 + n * 60 + (r() - 0.5) * 50),
    clamp(90 + n * 130 + (r() - 0.5) * 60),
    clamp(30 + n * 40),
    255,
  ];
}, 14);

// glTF --------------------------------------------------------------------------
const chunks: Uint8Array[] = [];
let length = 0;
const views: object[] = [];
const accessors: object[] = [];
function view(data: Uint8Array, extra: object = {}) {
  const pad = (4 - (data.length % 4)) % 4;
  views.push({
    buffer: 0,
    byteOffset: length,
    byteLength: data.length,
    ...extra,
  });
  chunks.push(data, new Uint8Array(pad));
  length += data.length + pad;
  return views.length - 1;
}
function accessor(
  bufferView: number,
  componentType: number,
  count: number,
  type: string,
  extra: object = {},
) {
  accessors.push({ bufferView, componentType, count, type, ...extra });
  return accessors.length - 1;
}
const bytes = (a: ArrayBufferView) =>
  new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
function primitive(g: ReturnType<typeof terrain>, material: number) {
  const count = g.positions.length / 3;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], g.positions[i]);
    max[i % 3] = Math.max(max[i % 3], g.positions[i]);
  }
  return {
    attributes: {
      POSITION: accessor(
        view(bytes(g.positions), { target: 34962 }),
        5126,
        count,
        "VEC3",
        { min, max },
      ),
      NORMAL: accessor(
        view(bytes(g.normals), { target: 34962 }),
        5126,
        count,
        "VEC3",
      ),
      TEXCOORD_0: accessor(
        view(bytes(g.uvs), { target: 34962 }),
        5126,
        count,
        "VEC2",
      ),
    },
    indices: accessor(
      view(bytes(g.indices), { target: 34963 }),
      5125,
      g.indices.length,
      "SCALAR",
    ),
    material,
  };
}
const image = (data: Uint8Array) => view(data);
const images = [rock, normalMap, orm, moss].map((d) => ({
  mimeType: "image/png",
  bufferView: image(d),
}));
const meshes = [
  { name: "Terrain", primitives: [primitive(terrain(GRID), 0)] },
  {
    name: "Boulder",
    primitives: [primitive(sphere(160, 320, 1.4, [0, 0, 0]), 1)],
  },
  { name: "Orb", primitives: [primitive(sphere(120, 240, 0.9, [0, 0, 0]), 2)] },
  { name: "Lamp", primitives: [primitive(sphere(64, 128, 0.5, [0, 0, 0]), 3)] },
];
const json = {
  asset: { version: "2.0", generator: "ink scripts/gen-big-gltf.ts" },
  scene: 0,
  scenes: [{ nodes: [0, 1, 2, 3] }],
  nodes: [
    { name: "Terrain", mesh: 0 },
    { name: "Boulder", mesh: 1, translation: [-6, 2.2, 3] },
    { name: "Orb", mesh: 2, translation: [4, 2.6, -2] },
    { name: "Lamp", mesh: 3, translation: [0, 4.2, 6] },
  ],
  meshes,
  materials: [
    {
      name: "Rock",
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        metallicRoughnessTexture: { index: 2 },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      normalTexture: { index: 1 },
      occlusionTexture: { index: 2 },
    },
    {
      name: "Moss",
      pbrMetallicRoughness: {
        baseColorTexture: { index: 3 },
        metallicFactor: 0,
        roughnessFactor: 0.9,
      },
    },
    {
      name: "Brushed metal",
      pbrMetallicRoughness: {
        baseColorFactor: [0.8, 0.82, 0.85, 1],
        metallicFactor: 1,
        roughnessFactor: 0.28,
      },
    },
    {
      name: "Lamp glow",
      pbrMetallicRoughness: {
        baseColorFactor: [1, 0.85, 0.5, 1],
        metallicFactor: 0,
        roughnessFactor: 0.4,
      },
      emissiveFactor: [1, 0.7, 0.3],
    },
  ],
  textures: [0, 1, 2, 3].map((source) => ({ source })),
  images,
  accessors,
  bufferViews: views,
  buffers: [{ byteLength: length }],
};

const text = new TextEncoder().encode(JSON.stringify(json));
const jsonLength = Math.ceil(text.length / 4) * 4;
const total = 12 + 8 + jsonLength + 8 + length;
const glb = new Uint8Array(total);
const dv = new DataView(glb.buffer);
dv.setUint32(0, 0x46546c67, true);
dv.setUint32(4, 2, true);
dv.setUint32(8, total, true);
dv.setUint32(12, jsonLength, true);
dv.setUint32(16, 0x4e4f534a, true);
glb.set(text, 20);
glb.fill(0x20, 20 + text.length, 20 + jsonLength);
let at = 20 + jsonLength;
dv.setUint32(at, length, true);
dv.setUint32(at + 4, 0x004e4942, true);
at += 8;
for (const c of chunks) {
  glb.set(c, at);
  at += c.length;
}
await Deno.mkdir(out.slice(0, Math.max(0, out.lastIndexOf("/"))) || ".", {
  recursive: true,
});
await Deno.writeFile(out, glb);
const tris = meshes.reduce(
  (n, m) =>
    n +
    m.primitives.reduce(
      (k, p) => k + (accessors[p.indices] as { count: number }).count / 3,
      0,
    ),
  0,
);
console.log(
  `${out}: ${
    (total / 1e6).toFixed(1)
  } MB, ${tris.toLocaleString()} triangles, ${images.length} textures (${TEX}px)`,
);
