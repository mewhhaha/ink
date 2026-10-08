/** Shadows and ambient occlusion, rendered on a real GPU adapter. */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { boxBrush, mat4, quat, type Vec3 } from "@ink/geometry";
import {
  type Catalog,
  type SceneEntity,
  sceneToWorld,
  standard,
} from "@ink/schema";
import {
  type Camera,
  createRenderer,
  extractScene,
  lookAtCamera,
  type Overlays,
  type PixelData,
  type Renderer,
  type RenderScene,
} from "./mod.ts";
import { schema } from "./fixture.ts";
import { indoorWorld, shadowCatalog } from "./fixture_shadows.ts";
import { cascadeSplits, planCascades } from "./systems/shadows.ts";

const gpu = (globalThis.navigator as Navigator & { gpu?: GPU })?.gpu;
const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
const test = (
  name: string,
  fn: (renderer: Renderer) => Promise<void> | void,
) =>
  Deno.test({
    name,
    ignore: !adapter,
    async fn() {
      const renderer = await createRenderer({
        assetBase: "file:///nowhere/",
        quality: "high",
      });
      const errors: string[] = [];
      renderer.device.addEventListener("uncapturederror", (e) => {
        errors.push((e as GPUUncapturedErrorEvent).error.message);
      });
      try {
        await fn(renderer);
        await renderer.device.queue.onSubmittedWorkDone();
        assertEquals(errors, []);
      } finally {
        renderer.dispose();
      }
    },
  });

// Helpers ------------------------------------------------------------------------

const catalog: Catalog = {
  assets: { mesh: [...standard.builtinMeshes], texture: [] },
};
type Extra = Record<string, unknown>;

const mesh = (
  id: number,
  shape: string,
  position: Vec3,
  scale: Vec3 = [1, 1, 1],
  extra: Extra = {},
): SceneEntity => ({
  id,
  name: `m${id}`,
  components: {
    transform: { position, scale },
    mesh: { shape, color: [0.7, 0.7, 0.7, 1], roughness: 0.9, ...extra },
  },
});
const light = (id: number, position: Vec3, euler: Vec3, l: Extra) => ({
  id,
  name: `l${id}`,
  components: {
    transform: { position, rotation: quat.fromEuler(euler) },
    light: l,
  },
});
const brush = (id: number, min: Vec3, max: Vec3): SceneEntity => ({
  id,
  name: `b${id}`,
  components: {
    transform: { position: [0, 0, 0] },
    brush: {
      faces: boxBrush(min, max).map((f) => ({
        ...f,
        color: [0.8, 0.8, 0.8, 1],
      })),
    },
  },
});

const FLAT: Overlays["environment"] = {
  tonemap: "linear",
  bloom: 0,
  vignette: 0,
  grain: 0,
};

function sceneOf(
  entities: SceneEntity[],
  environment: Extra = {},
  cat: Catalog = catalog,
): RenderScene {
  const all = [...entities, {
    id: 9999,
    name: "env",
    components: { environment },
  }];
  return extractScene(
    sceneToWorld(schema, { ink: 1, entities: all }, cat).world,
    cat,
  );
}

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
/** Linear luminance around a pixel (a (2r+1)^2 box). */
function lumAt(p: PixelData, x: number, y: number, r = 1): number {
  let sum = 0, n = 0;
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const xx = Math.min(Math.max(Math.round(x) + i, 0), p.width - 1);
      const yy = Math.min(Math.max(Math.round(y) + j, 0), p.height - 1);
      const o = (yy * p.width + xx) * 4;
      sum += 0.2126 * lin(p.data[o]) + 0.7152 * lin(p.data[o + 1]) +
        0.0722 * lin(p.data[o + 2]);
      n++;
    }
  }
  return sum / n;
}
function project(cam: Camera, p: Vec3, w: number, h: number): [number, number] {
  const m = mat4.multiply(cam.projection, cam.view);
  const c = mat4.transformPoint(m, p);
  return [(c[0] * 0.5 + 0.5) * w, (0.5 - c[1] * 0.5) * h];
}
async function draw(
  renderer: Renderer,
  scene: RenderScene,
  cam: Camera,
  w: number,
  h: number,
  overlays: Overlays = {},
): Promise<PixelData> {
  const view = renderer.createView({ width: w, height: h });
  view.render(scene, cam, {
    ...overlays,
    environment: { ...FLAT, ...overlays.environment },
  });
  const pixels = await view.readPixels();
  view.dispose();
  return pixels;
}

/** Where the shadow of a box's top falls on the ground plane y = 0: halfway
 * between the box centre's foot and the projected top centre. */
function shadowSpot(box: Vec3, top: number, dir: Vec3): Vec3 {
  const t = -top / dir[1];
  const tip: Vec3 = [box[0] + dir[0] * t, 0, box[2] + dir[2] * t];
  return [(box[0] + tip[0]) / 2, 0, (box[2] + tip[2]) / 2];
}

// Sun ----------------------------------------------------------------------------

const sunEntity = (euler: Vec3, extra: Extra = {}) =>
  light(500, [0, 30, 0], euler, {
    kind: "directional",
    intensity: 3,
    shadows: true,
    ...extra,
  });

test("cascades shadow near, far and off-screen casters", async (renderer) => {
  const world = (shadows: boolean) =>
    sceneOf([
      mesh(1, "builtin:plane", [0, 0, 0], [600, 1, 600]),
      mesh(2, "builtin:cube", [0, 0.5, 0]),
      mesh(3, "builtin:cube", [0, 1.5, -45], [3, 3, 3]),
      // A tower far to the side of the view, towards the light: its shadow
      // reaches into the picture from a caster the camera never sees.
      mesh(4, "builtin:cylinder", [40, 10, -10], [3, 20, 3]),
      sunEntity([-25, 90, 0], { shadows }),
    ], { shadow_distance: 120 });
  const on = world(true), off = world(false);
  const dir = on.lights[0].direction;
  const W = 640, H = 360;
  const cam = lookAtCamera(
    [0, 12, 16],
    [0, 0, -25],
    { fov: 60, far: 400 },
    W / H,
  );
  const lit = await draw(renderer, on, cam, W, H);
  const unlit = await draw(renderer, off, cam, W, H);
  const spots: [string, Vec3][] = [
    ["near box", shadowSpot([0, 0, 0], 1, dir)],
    ["far box", shadowSpot([0, 0, -45], 3, dir)],
    ["tower", shadowSpot([40, 0, -10], 20, dir)],
  ];
  for (const [name, p] of spots) {
    const [x, y] = project(cam, p, W, H);
    assert(x > 0 && x < W && y > 0 && y < H, `${name} spot in view: ${x},${y}`);
    const ratio = lumAt(lit, x, y) / lumAt(unlit, x, y);
    assert(ratio < 0.65, `${name} is shadowed: ratio ${ratio.toFixed(2)}`);
  }
  // Away from every caster nothing is darkened.
  const [x, y] = project(cam, [8, 0, -20], W, H);
  const open = lumAt(lit, x, y) / lumAt(unlit, x, y);
  assert(open > 0.95, `open ground stays lit: ${open.toFixed(3)}`);
});

test("cascade splits blend logarithmic and uniform and end at the far plane", () => {
  const s = cascadeSplits(0.1, 80, 4);
  assertEquals(s.length, 4);
  assertEquals(s[3], 80);
  assert(s[0] > 0.1 && s[0] < s[1] && s[1] < s[2] && s[2] < s[3]);
  // The first cascade is much shorter than a uniform split would make it.
  assert(s[0] < 80 / 4 / 2, `first split ${s[0]}`);
  const u = cascadeSplits(0.1, 80, 4, true);
  assert(Math.abs(u[0] - (0.1 + 79.9 / 4)) < 1e-9);
});

test("cascade maps do not move for sub-texel camera motion", () => {
  const input = (eye: Vec3, target: Vec3) => ({
    camera: lookAtCamera(eye, target, { fov: 60, far: 400 }, 16 / 9),
    direction: [-0.4, -0.7, -0.59] as Vec3,
    casterBounds: { min: [-20, 0, -60] as Vec3, max: [20, 6, 20] as Vec3 },
    sceneBounds: null,
    distance: 100,
    count: 4,
    size: 2048,
  });
  const a = planCascades(input([1, 3, 10], [0, 0, 0]));
  // Translate by a tenth of the smallest texel, and turn by a hair.
  const shift = a.texels[0] * 0.1;
  const b = planCascades(input([1 + shift, 3, 10], [shift, 0, 0]));
  const c = planCascades(input([1, 3, 10], [0.00002, 0, 0]));
  for (let i = 0; i < 4; i++) {
    assertEquals(
      Array.from(a.matrices[i]),
      Array.from(b.matrices[i]),
      `move ${i}`,
    );
    assertEquals(
      Array.from(a.matrices[i]),
      Array.from(c.matrices[i]),
      `turn ${i}`,
    );
    // Radii only depend on the camera lens, never on where it points.
    assertEquals(a.radii[i], b.radii[i]);
  }
  // A texel or more is a real change.
  const far = planCascades(
    input([1 + a.texels[0] * 3, 3, 10], [a.texels[0] * 3, 0, 0]),
  );
  assertNotEquals(Array.from(a.matrices[0]), Array.from(far.matrices[0]));
});

test("shadow edges do not shimmer when the camera creeps", async (renderer) => {
  const scene = sceneOf([
    mesh(1, "builtin:plane", [0, 0, 0], [100, 1, 100]),
    mesh(2, "builtin:cube", [0, 0.5, 0]),
    mesh(3, "builtin:cube", [3, 0.5, -4], [1, 1, 1]),
    mesh(4, "builtin:cylinder", [-3, 1, -2], [0.6, 2, 0.6]),
    sunEntity([-40, 40, 0]),
  ]);
  const W = 640, H = 360;
  const at = (z: number, yaw = 0) =>
    lookAtCamera([yaw, 4, z], [0, 0, 0], { fov: 55 }, W / H);
  const view = renderer.createView({ width: W, height: H });
  const overlays: Overlays = { environment: FLAT };
  view.render(scene, at(9), overlays);
  const first = view.stats.passes;
  const a = await view.readPixels();
  // Sub-texel creep: the maps are reused (fewer passes) and the picture is
  // the same up to the sub-pixel change of the camera itself.
  view.render(scene, at(9 - 0.0004), overlays);
  const creep = view.stats.passes;
  const b = await view.readPixels();
  assert(creep < first, `cascades are reused: ${first} -> ${creep} passes`);
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i + 1] - b.data[i + 1]);
  }
  assert(sum / (W * H) < 0.6, `mean change ${(sum / (W * H)).toFixed(3)}`);
  view.dispose();
});

test("softness controls the penumbra: hard at contact, wider with distance", async (renderer) => {
  // Top-down orthographic view of a tall slab's shadow on the ground.
  const world = (softness: number) =>
    sceneOf([
      mesh(1, "builtin:plane", [0, 0, 0], [60, 1, 60]),
      mesh(2, "builtin:cube", [0, 3, 0], [0.3, 6, 3]),
      sunEntity([-35, 90, 0], { softness, intensity: 8 }),
    ]);
  const W = 512, H = 512;
  const cam = lookAtCamera([0, 40, 0], [0, 0, 0], {
    orthographic: true,
    size: 14,
    far: 100,
    up: [0, 0, -1],
  }, 1);
  const dir = world(1).lights[0].direction;
  const along: Vec3 = [dir[0], 0, dir[2]];
  const norm = Math.hypot(along[0], along[2]);
  const length = (6 * norm) / -dir[1];
  const u: Vec3 = [along[0] / norm, 0, along[2] / norm];
  const side: Vec3 = [-u[2], 0, u[0]];
  /** Width (px) of the 10%..90% edge across the shadow, at distance `d` m
   * from the pole along the shadow. */
  const edgeWidth = async (softness: number, d: number) => {
    const p = await draw(renderer, world(softness), cam, W, H, {
      environment: { exposure: -3 },
    });
    const pxPerM = W / 14;
    const profile: number[] = [];
    for (let s = -2.5; s <= 0; s += 1 / pxPerM) {
      const q: Vec3 = [
        u[0] * d + side[0] * s,
        0,
        u[2] * d + side[2] * s,
      ];
      const [x, y] = project(cam, q, W, H);
      profile.push(lumAt(p, x, y, 0));
    }
    // Profile runs from outside the shadow (lit) towards the shadow axis.
    const hi = Math.max(...profile), lo = Math.min(...profile);
    let a = -1, b = -1;
    profile.forEach((v, i) => {
      const t = (v - lo) / (hi - lo);
      if (a < 0 && t < 0.9) a = i;
      if (t < 0.1 && b < 0) b = i;
    });
    return { width: (b - a) / pxPerM, hi, lo };
  };
  const hardNear = await edgeWidth(0, 0.8 * length * 0.1 + 0.4);
  const hardFar = await edgeWidth(0, length * 0.85);
  const softNear = await edgeWidth(3, 0.8 * length * 0.1 + 0.4);
  const softFar = await edgeWidth(3, length * 0.85);
  assert(hardFar.hi / hardFar.lo > 1.5, "the slab casts a shadow");
  assert(hardFar.width < 0.12, `hard edge ${hardFar.width.toFixed(3)} m`);
  assert(hardNear.width < 0.12, `hard edge ${hardNear.width.toFixed(3)} m`);
  assert(
    softFar.width > 3 * hardFar.width && softFar.width > 0.35,
    `soft far ${softFar.width.toFixed(3)} vs hard ${hardFar.width.toFixed(3)}`,
  );
  assert(
    softFar.width > 2 * softNear.width,
    `contact hardening: near ${softNear.width.toFixed(3)} far ${
      softFar.width.toFixed(3)
    }`,
  );
});

test("orthographic editor views cast shadows too", async (renderer) => {
  const scene = (shadows: boolean) =>
    sceneOf([
      mesh(1, "builtin:plane", [0, 0, 0], [60, 1, 60]),
      mesh(2, "builtin:cube", [0, 1, 0], [2, 2, 2]),
      sunEntity([-40, 90, 0], { shadows }),
    ]);
  const on = scene(true), off = scene(false);
  const dir = on.lights[0].direction;
  const spot = shadowSpot([0, 0, 0], 2, dir);
  for (
    const [name, eye, up] of [
      ["top", [0, 30, 0], [0, 0, -1]],
      ["front", [0, 6, 30], [0, 1, 0]],
    ] as [string, Vec3, Vec3][]
  ) {
    const cam = lookAtCamera(eye, [0, name === "top" ? 0 : 2, 0], {
      orthographic: true,
      size: 16,
      far: 200,
      up,
    }, 1);
    const [x, y] = project(cam, spot, 256, 256);
    const lit = await draw(renderer, on, cam, 256, 256);
    const unlit = await draw(renderer, off, cam, 256, 256);
    const ratio = lumAt(lit, x, y) / lumAt(unlit, x, y);
    assert(ratio < 0.4, `${name} view: ratio ${ratio.toFixed(2)}`);
  }
});

test("shadow-casting off for a mesh leaves no shadow; moving a caster updates the maps", async (renderer) => {
  const W = 320, H = 180;
  const entities = (x: number, casts: boolean) => [
    mesh(1, "builtin:plane", [0, 0, 0], [60, 1, 60]),
    mesh(2, "builtin:cube", [x, 0.5, 0], [1, 1, 1], { cast_shadows: casts }),
    sunEntity([-40, 90, 0]),
  ];
  const cam = lookAtCamera([0, 9, 9], [0, 0, 0], { fov: 50 }, W / H);
  const view = renderer.createView({ width: W, height: H });
  const overlays: Overlays = { environment: FLAT };
  const dir = sceneOf(entities(0, true)).lights[0].direction;
  const spotAt = (x: number) =>
    project(cam, shadowSpot([x, 0, 0], 1, dir), W, H);
  view.render(sceneOf(entities(0, true)), cam, overlays);
  const a = await view.readPixels();
  view.render(sceneOf(entities(0, false)), cam, overlays);
  const none = await view.readPixels();
  const [sx, sy] = spotAt(0);
  assert(lumAt(a, sx, sy) < 0.7 * lumAt(none, sx, sy), "shadow from caster");
  view.render(sceneOf(entities(4, true)), cam, overlays);
  const moved = await view.readPixels();
  const [mx, my] = spotAt(4);
  assert(lumAt(moved, mx, my) < 0.7 * lumAt(none, mx, my), "shadow follows");
  assert(
    lumAt(moved, sx, sy) > 0.9 * lumAt(none, sx, sy),
    "old shadow is gone",
  );
  view.dispose();
});

// Local lights -------------------------------------------------------------------

test("a spot light casts a shadow", async (renderer) => {
  const world = (shadows: boolean) =>
    sceneOf([
      mesh(1, "builtin:plane", [0, 0, 0], [60, 1, 60]),
      mesh(2, "builtin:cube", [1.5, 0.5, 0]),
      light(3, [0, 5, 0], [-90, 0, 0], {
        kind: "spot",
        intensity: 220,
        range: 20,
        angle: 100,
        shadows,
      }),
    ]);
  const W = 400, H = 300;
  const cam = lookAtCamera([5, 6, 7], [1, 0, 0], { fov: 55 }, W / H);
  const on = await draw(renderer, world(true), cam, W, H);
  const off = await draw(renderer, world(false), cam, W, H);
  const shadowed = project(cam, [2.25, 0, 0], W, H);
  const open = project(cam, [-2, 0, 0], W, H);
  const ratio = lumAt(on, ...shadowed) / lumAt(off, ...shadowed);
  assert(ratio < 0.5, `behind the cube: ${ratio.toFixed(2)}`);
  const free = lumAt(on, ...open) / lumAt(off, ...open);
  assert(free > 0.95, `elsewhere unchanged: ${free.toFixed(3)}`);
});

test("a point light casts shadows into all six cube faces", async (renderer) => {
  const world = (shadows: boolean) =>
    sceneOf([
      brush(1, [-7, -7, -7], [7, -6, 7]),
      brush(2, [-7, 6, -7], [7, 7, 7]),
      brush(3, [-7, -6, -7], [-6, 6, 7]),
      brush(4, [6, -6, -7], [7, 6, 7]),
      brush(5, [-6, -6, -7], [6, 6, -6]),
      brush(6, [-6, -6, 6], [6, 6, 7]),
      ...([
        [3, 0, 0],
        [-3, 0, 0],
        [0, 3, 0],
        [0, -3, 0],
        [0, 0, 3],
        [0, 0, -3],
      ] as Vec3[]).map((p, i) => mesh(10 + i, "builtin:cube", p)),
      light(30, [0, 0, 0], [0, 0, 0], {
        kind: "point",
        intensity: 140,
        range: 30,
        shadows,
      }),
    ]);
  const on = world(true), off = world(false);
  const W = 256, H = 256;
  const dirs: Vec3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const names = ["+x", "-x", "+y", "-y", "+z", "-z"];
  for (let i = 0; i < 6; i++) {
    const d = dirs[i];
    const perp: Vec3 = d[0] !== 0 ? [0, 0, 3.5] : [3.5, 0, 0];
    const eye: Vec3 = [
      -4 * d[0] + perp[0],
      -4 * d[1] + perp[1],
      -4 * d[2] + perp[2],
    ];
    const wall: Vec3 = [6 * d[0], 6 * d[1], 6 * d[2]];
    const cam = lookAtCamera(eye, wall, {
      fov: 60,
      up: d[1] !== 0 ? [0, 0, 1] : [0, 1, 0],
    }, 1);
    const [x, y] = project(cam, wall, W, H);
    const lit = await draw(renderer, on, cam, W, H);
    const unlit = await draw(renderer, off, cam, W, H);
    const ratio = lumAt(lit, x, y) / lumAt(unlit, x, y);
    assert(
      ratio < 0.55,
      `${names[i]} face: shadowed ratio ${ratio.toFixed(2)}`,
    );
    // A wall point away from the occluder (1.2 wall units sideways) is lit.
    const sideways: Vec3 = d[0] !== 0
      ? [6 * d[0], 0, 4.8]
      : [4.8, 6 * d[1], 6 * d[2]];
    const [sx, sy] = project(cam, sideways, W, H);
    const free = lumAt(lit, sx, sy) / lumAt(unlit, sx, sy);
    assert(free > 0.9, `${names[i]} face: lit elsewhere ${free.toFixed(2)}`);
  }
});

test("more shadow-casting lights than the budget still render", (renderer) => {
  const entities: SceneEntity[] = [
    mesh(1, "builtin:plane", [0, 0, 0], [60, 1, 60]),
    mesh(2, "builtin:cube", [0, 0.5, 0]),
  ];
  for (let i = 0; i < 14; i++) {
    entities.push(
      light(10 + i, [Math.cos(i) * 5, 3, Math.sin(i) * 5], [-90, 0, 0], {
        kind: i % 2 ? "spot" : "point",
        intensity: 20,
        range: 10,
        angle: 80,
        shadows: true,
      }),
    );
  }
  const view = renderer.createView({ width: 256, height: 144 });
  const cam = lookAtCamera([0, 8, 10], [0, 0, 0], { fov: 55 }, 16 / 9);
  const scene = sceneOf(entities);
  view.render(scene, cam, {});
  const first = view.stats.passes;
  // 4 cascades + atlas + 4 cubes x 6 faces + AO (4) + main + post.
  assert(first < 4 + 1 + 24 + 4 + 40, `passes ${first}`);
  view.render(scene, cam, {});
  assert(view.stats.passes < first, "static scene reuses its shadow maps");
  view.dispose();
});

// Ambient occlusion --------------------------------------------------------------

const cornerScene = (environment: Extra = {}) =>
  sceneOf([
    brush(1, [-10, -1, -10], [10, 0, 10]),
    brush(2, [-10, 0, -10], [10, 4, -9]),
    light(3, [0, 5, 0], [-90, 0, 0], { kind: "directional", intensity: 0 }),
  ], { ambient_occlusion: 1, ao_radius: 0.6, ...environment });
const cornerCamera = (w: number, h: number) =>
  lookAtCamera([0.3, 1.6, -5], [0, 0, -9], { fov: 60 }, w / h);

test("ambient occlusion darkens a corner and leaves the open floor alone", async (renderer) => {
  const W = 800, H = 450;
  const cam = cornerCamera(W, H);
  const on = await draw(renderer, cornerScene(), cam, W, H);
  const off = await draw(
    renderer,
    cornerScene({ ambient_occlusion: 0 }),
    cam,
    W,
    H,
  );
  const [cx, cy] = project(cam, [0, 0, -9], W, H);
  let darkest = 1;
  for (let dy = -10; dy <= 10; dy += 2) {
    darkest = Math.min(
      darkest,
      lumAt(on, cx, cy + dy) / lumAt(off, cx, cy + dy),
    );
  }
  assert(darkest < 0.75, `crease keeps ${darkest.toFixed(2)} of its light`);
  const [fx, fy] = project(cam, [0.3, 0, -2], W, H);
  const open = lumAt(on, fx, fy, 3) / lumAt(off, fx, fy, 3);
  assert(open > 0.97, `open floor keeps ${open.toFixed(3)}`);
  // The wall well above the crease is open too.
  const [wx, wy] = project(cam, [0, 3, -9], W, H);
  assert(lumAt(on, wx, wy, 3) / lumAt(off, wx, wy, 3) > 0.97);
});

test("ao_radius scales how far occlusion reaches", async (renderer) => {
  const W = 800, H = 450;
  const cam = cornerCamera(W, H);
  const reach = async (radius: number) => {
    const on = await draw(
      renderer,
      cornerScene({ ao_radius: radius }),
      cam,
      W,
      H,
    );
    const off = await draw(
      renderer,
      cornerScene({ ambient_occlusion: 0 }),
      cam,
      W,
      H,
    );
    // One metre in front of the wall.
    const [x, y] = project(cam, [0, 0, -8], W, H);
    return lumAt(on, x, y, 2) / lumAt(off, x, y, 2);
  };
  const small = await reach(0.3);
  const large = await reach(2.5);
  assert(
    large < small - 0.04,
    `radius 0.3 keeps ${small.toFixed(2)}, 2.5 keeps ${large.toFixed(2)}`,
  );
});

test("low quality skips ambient occlusion", async (renderer) => {
  const W = 400, H = 225;
  const cam = cornerCamera(W, H);
  const view = renderer.createView({ width: W, height: H });
  const run = async (quality: "low" | "high", environment: Extra) => {
    view.render(cornerScene(environment), cam, { quality, environment: FLAT });
    return { passes: view.stats.passes, pixels: await view.readPixels() };
  };
  const high = await run("high", {});
  const low = await run("low", {});
  const lowOff = await run("low", { ambient_occlusion: 0 });
  assert(low.passes <= high.passes - 4, `${low.passes} vs ${high.passes}`);
  assertEquals(low.pixels.data, lowOff.pixels.data);
  assertNotEquals(high.pixels.data, lowOff.pixels.data);
  view.dispose();
});

test("debug views draw and differ from the normal picture", async (renderer) => {
  const scene = extractScene(indoorWorld(), shadowCatalog);
  const cam = lookAtCamera([-7, 2, 7], [1.5, 1.3, -2.5], { fov: 72 }, 16 / 9);
  const base = await draw(renderer, scene, cam, 320, 180);
  for (const debug of ["cascades", "ao", "shadow-atlas"] as const) {
    for (const quality of ["high", "low"] as const) {
      const p = await draw(renderer, scene, cam, 320, 180, { debug, quality });
      assertNotEquals(p.data, base.data, `${debug}/${quality}`);
    }
  }
});

test("the indoor level renders at both qualities without errors", async (renderer) => {
  const scene = extractScene(indoorWorld(), shadowCatalog);
  for (const quality of ["high", "low"] as const) {
    const cam = lookAtCamera(
      [10.5, 1.6, 0.4],
      [20, 1.4, -0.2],
      { fov: 70 },
      16 / 9,
    );
    const p = await draw(renderer, scene, cam, 256, 144, { quality });
    assert(lumAt(p, 128, 72, 40) > 0.001);
  }
});
