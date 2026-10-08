/** Renders offscreen on a real GPU adapter and checks pixels and picks. */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { builtinTexture, mat4, quat, type Vec3 } from "@ink/geometry";
import {
  createRenderer,
  type Draw,
  type Environment,
  extractScene,
  type LightDraw,
  lookAtCamera,
  type Overlays,
  type PixelData,
  type Renderer,
  type RenderScene,
  sceneGizmos,
} from "./mod.ts";
import type { Assets } from "./assets.ts";
import { sunLightFactor } from "./sky_model.ts";
import {
  catalog,
  fixtureWorld,
  labCatalog,
  labWorld,
  normalMapFromHeight,
  ormFromHeight,
} from "./fixture.ts";

const gpu = (globalThis.navigator as Navigator & { gpu?: GPU })?.gpu;
const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
// Reuse the native device as the editor does. Some drivers retain substantial
// per-device allocations until JS wrappers are collected, even after destroy.
const device = adapter ? await adapter.requestDevice() : undefined;
globalThis.addEventListener("unload", () => device?.destroy());
const test = (
  name: string,
  fn: (renderer: Renderer) => Promise<void> | void,
) =>
  Deno.test({
    name,
    ignore: !adapter,
    async fn() {
      const renderer = await createRenderer({
        device,
        assetBase: "file:///nowhere/",
      });
      // Every test also asserts that the GPU reported no validation errors.
      const errors: string[] = [];
      const onError = (e: Event) => {
        errors.push((e as GPUUncapturedErrorEvent).error.message);
      };
      renderer.device.addEventListener("uncapturederror", onError);
      try {
        await fn(renderer);
        await renderer.device.queue.onSubmittedWorkDone();
        assertEquals(errors, []);
      } finally {
        renderer.dispose();
        renderer.device.removeEventListener("uncapturederror", onError);
      }
    },
  });

const W = 640, H = 360;
const camera = () =>
  lookAtCamera([5.5, 4.2, 8.5], [0, 0.6, -0.5], { fov: 50 }, W / H);
const pixel = (p: PixelData, x: number, y: number) =>
  Array.from(p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4));
const checker = () => {
  const data = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) data.set([200, 200, 200, 255], i * 4);
  return { width: 64, height: 64, data };
};

test("renders a lit scene, deterministically", async (renderer) => {
  renderer.assets.setTexture("textures/checker.png", checker());
  const scene = extractScene(fixtureWorld(), catalog);
  const view = renderer.createView({ width: W, height: H });
  view.render(scene, camera(), { grid: { plane: "xz", spacing: 1 } });
  const a = await view.readPixels();
  view.render(scene, camera(), { grid: { plane: "xz", spacing: 1 } });
  const b = await view.readPixels();
  assertEquals(a.width, W);
  assertEquals(a.data.length, W * H * 4);
  assertEquals(a.data, b.data);
  // Sky at the top is blue-ish and brighter in blue than red; the frame has
  // plenty of variation and is fully opaque.
  const sky = pixel(a, 20, 5);
  assert(sky[2] > sky[0], `sky ${sky}`);
  assertEquals(sky[3], 255);
  const distinct = new Set<number>();
  for (let i = 0; i < a.data.length; i += 4 * 97) {
    distinct.add((a.data[i] << 16) | (a.data[i + 1] << 8) | a.data[i + 2]);
  }
  assert(distinct.size > 50);
});

test("still renders repeat exactly, whatever other views rendered", async (renderer) => {
  renderer.assets.setTexture("textures/checker.png", checker());
  const scene = extractScene(fixtureWorld(), catalog);
  const options = {
    still: true,
    quality: "high" as const,
    environment: { grain: 1, vignette: 0.5, autoExposure: true },
  };
  const a = renderer.createView({ width: W, height: H });
  a.render(scene, camera(), options);
  const first = await a.readPixels();
  const other = renderer.createView({ width: W, height: H });
  for (let i = 0; i < 5; i++) other.render(scene, camera(), options);
  a.render(scene, camera(), options);
  const again = await a.readPixels();
  const fresh = renderer.createView({ width: W, height: H });
  fresh.render(scene, camera(), options);
  const elsewhere = await fresh.readPixels();
  assertEquals(first.data, again.data);
  assertEquals(first.data, elsewhere.data);
  for (const v of [a, other, fresh]) v.dispose();
});

test("still renders repeat exactly at low quality too", async (renderer) => {
  renderer.assets.setTexture("textures/checker.png", checker());
  const scene = extractScene(fixtureWorld(), catalog);
  const options = { still: true, quality: "low" as const };
  const capture = async () => {
    const v = renderer.createView({ width: W, height: H });
    v.render(scene, camera(), options);
    // Other views keep rendering between a capture's two frames.
    const other = renderer.createView({ width: W, height: H });
    for (let i = 0; i < 9; i++) other.render(scene, camera(), {});
    v.render(scene, camera(), options);
    const pixels = await v.readPixels();
    v.dispose();
    other.dispose();
    return pixels;
  };
  const first = await capture();
  for (let i = 0; i < 3; i++) assertEquals((await capture()).data, first.data);
});

test("flat background colour is honoured", async (renderer) => {
  const view = renderer.createView({ width: 64, height: 64 });
  const scene = extractScene(fixtureWorld(), catalog);
  view.render(scene, lookAtCamera([0, 40, 0.01], [0, 50, 0], {}, 1), {
    background: [1, 0, 0, 1],
  });
  const p = await view.readPixels();
  await renderer.assets.settled();
  assertEquals(pixel(p, 32, 32), [255, 0, 0, 255]);
});

test("unlit shows base colours and wireframe differs from lit", async (renderer) => {
  const scene = extractScene(fixtureWorld(), catalog);
  const view = renderer.createView({ width: W, height: H });
  view.render(scene, camera(), { shading: "unlit" });
  const unlit = await view.readPixels();
  view.render(scene, camera(), { shading: "wireframe" });
  const wire = await view.readPixels();
  view.render(scene, camera(), { shading: "lit" });
  const lit = await view.readPixels();
  assertNotEquals(unlit.data, lit.data);
  assertNotEquals(wire.data, lit.data);
  // Wireframe leaves most of the frame as the flat background.
  const bg = pixel(wire, 5, 5);
  let same = 0;
  for (let i = 0; i < wire.data.length; i += 4) {
    // The final pass dithers by up to one level.
    if (
      Math.abs(wire.data[i] - bg[0]) <= 2 &&
      Math.abs(wire.data[i + 1] - bg[1]) <= 2 &&
      Math.abs(wire.data[i + 2] - bg[2]) <= 2
    ) same++;
  }
  assert(same > (W * H) / 2);
});

test("picking returns entity, brush face, point and normal", async (renderer) => {
  const scene = extractScene(fixtureWorld(), catalog);
  const view = renderer.createView({ width: W, height: H });
  view.render(scene, camera());
  // Find the gold sphere (entity 3) by projecting its centre.
  const vp = camera();
  const clipX = (p: number[]) => {
    const m = vp.projection, v = vp.view;
    const vx = v[0] * p[0] + v[4] * p[1] + v[8] * p[2] + v[12];
    const vy = v[1] * p[0] + v[5] * p[1] + v[9] * p[2] + v[13];
    const vz = v[2] * p[0] + v[6] * p[1] + v[10] * p[2] + v[14];
    const cx = m[0] * vx, cy = m[5] * vy, cw = -vz;
    return [((cx / cw) * 0.5 + 0.5) * W, (0.5 - (cy / cw) * 0.5) * H];
  };
  const [sx, sy] = clipX([0, 0.5, 1.4]);
  const sphere = await view.pick(sx, sy);
  assertEquals(sphere?.entity, 3);
  assertEquals(sphere?.face, -1);
  assert(
    sphere!.point[2] > 1.4 - 0.01,
    "front of the sphere is nearer the camera",
  );
  assert(
    Math.abs(
      Math.hypot(
        sphere!.point[0],
        sphere!.point[1] - 0.5,
        sphere!.point[2] - 1.4,
      ) - 0.5,
    ) < 0.02,
  );
  const [wx, wy] = clipX([-2.5, 1.5, -3.2]);
  const wall = await view.pick(wx, wy);
  assertEquals(wall?.entity, 13);
  assertEquals(wall?.face, 0); // the +X face of the wall brush
  assert(wall!.normal[0] > 0.9);
  assertEquals(await view.pick(2, 2), null);
  assertEquals(await view.pick(-5, 10), null);
});

test("selection draws an outline; lines and grid draw", async (renderer) => {
  const scene = extractScene(fixtureWorld(), catalog);
  const view = renderer.createView({ width: W, height: H });
  view.render(scene, camera(), {});
  const base = await view.readPixels();
  view.render(scene, camera(), { selection: [3] });
  const selected = await view.readPixels();
  let orange = 0;
  for (let i = 0; i < selected.data.length; i += 4) {
    const [r, g, b] = [
      selected.data[i],
      selected.data[i + 1],
      selected.data[i + 2],
    ];
    if (r > 230 && g > 120 && g < 190 && b < 80) orange++;
  }
  assert(orange > 100, `outline pixels: ${orange}`);
  assertNotEquals(base.data, selected.data);

  view.render(scene, camera(), {
    lines: [{
      from: [-4, 0.01, 4],
      to: [4, 0.01, 4],
      color: [0, 1, 0, 1],
      width: 4,
    }],
    grid: { plane: "xz", spacing: 1 },
    selectedFaces: [{ entity: 13, face: 0 }],
    edges: true,
  });
  const extras = await view.readPixels();
  let green = 0;
  for (let i = 0; i < extras.data.length; i += 4) {
    if (
      extras.data[i + 1] > 200 && extras.data[i] < 80 && extras.data[i + 2] < 80
    ) green++;
  }
  assert(green > 200, `line pixels: ${green}`);
  assertNotEquals(extras.data, base.data);
});

test("orthographic views and gizmos render", async (renderer) => {
  const scene = extractScene(fixtureWorld(), catalog);
  const view = renderer.createView({ width: W, height: H });
  const top = lookAtCamera([0, 30, 0], [0, 0, 0], {
    orthographic: true,
    size: 16,
    up: [0, 0, -1],
  }, W / H);
  view.render(scene, top, {
    grid: { plane: "xz", spacing: 1 },
    background: [0.1, 0.1, 0.1, 1],
    lines: sceneGizmos(scene),
  });
  const p = await view.readPixels();
  // The X axis line (red) crosses the middle row of the plane view.
  let red = 0;
  for (let x = 0; x < W; x++) {
    const px = pixel(p, x, H / 2);
    if (px[0] > px[1] + 40 && px[0] > px[2] + 40) red++;
  }
  assert(red > 50, `x axis pixels: ${red}`);
});

test("capture yields a PNG; two views share a device; resize works", async (renderer) => {
  const scene = extractScene(fixtureWorld(), catalog);
  const a = renderer.createView({ width: 100, height: 50 });
  const b = renderer.createView({ width: 40, height: 40 });
  a.render(scene, camera());
  b.render(scene, camera());
  const png = new Uint8Array(await (await a.capture()).arrayBuffer());
  assertEquals(Array.from(png.slice(1, 4)), [80, 78, 71]);
  const bitmap = await createImageBitmap(new Blob([png as BlobPart]));
  assertEquals([bitmap.width, bitmap.height], [100, 50]);
  a.resize(60, 30, 2);
  assertEquals([a.width, a.height], [120, 60]);
  a.render(scene, camera());
  assertEquals((await a.readPixels()).data.length, 120 * 60 * 4);
  a.dispose();
  b.dispose();
});

test("missing and failing assets never throw", async (renderer) => {
  const scene = extractScene(fixtureWorld(), catalog);
  scene.draws.push({
    entity: 500,
    mesh: "models/gone.glb",
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 3, 1]),
    color: [1, 1, 1, 1],
    roughness: 0.5,
    metallic: 0,
    emissive: [0, 0, 0, 1],
    emissiveStrength: 1,
    normalStrength: 1,
    uvScale: [1, 1],
    castShadows: true,
  });
  renderer.assets.preload("mesh", "models/gone.glb");
  const view = renderer.createView({ width: 64, height: 64 });
  view.render(scene, camera());
  await new Promise((r) => setTimeout(r, 200));
  view.render(scene, camera());
  assertEquals((await view.readPixels()).width, 64);
});

// HDR pipeline ------------------------------------------------------------------

const draw = (over: Partial<Draw> = {}): Draw => ({
  entity: 1,
  mesh: "builtin:sphere",
  matrix: mat4.identity(),
  color: [0, 0, 0, 1],
  roughness: 0.6,
  metallic: 0,
  emissive: [1, 1, 1, 1],
  emissiveStrength: 1,
  normalStrength: 1,
  uvScale: [1, 1],
  castShadows: false,
  ...over,
});

/** The fixture scene's cameras and lights with only the given draws. */
const sceneOf = (draws: Draw[]): RenderScene => ({
  ...extractScene(fixtureWorld(), catalog),
  draws,
  brushes: [],
  lights: [],
});

const S = 256;
const head = () => lookAtCamera([0, 0, 3.2], [0, 0, 0], { fov: 40 }, 1);
const NO_POST: Partial<Environment> = {
  tonemap: "linear",
  bloom: 0,
  vignette: 0,
};
const luminance = (
  p: PixelData,
  x0 = 0,
  y0 = 0,
  x1 = p.width,
  y1 = p.height,
) => {
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * p.width + x) * 4;
      sum += 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] +
        0.0722 * p.data[i + 2];
      n++;
    }
  }
  return sum / n;
};

async function render(
  renderer: Renderer,
  scene: RenderScene,
  overlays: Overlays,
  camera = head(),
  size = S,
): Promise<PixelData> {
  const view = renderer.createView({ width: size, height: size });
  view.render(scene, camera, overlays);
  const pixels = await view.readPixels();
  view.dispose();
  return pixels;
}

test("HDR radiance above 1 survives into the post chain", async (renderer) => {
  // A surface of radiance 4: exposure -2 EV brings it exactly to white. If the
  // main pass had clipped at 1 it would come out dark grey instead.
  const scene = sceneOf([draw({ emissiveStrength: 4 })]);
  const flat = { background: [0, 0, 0, 1] as [number, number, number, number] };
  const at = (p: PixelData) => pixel(p, S / 2, S / 2);
  const white = at(
    await render(renderer, scene, {
      ...flat,
      environment: { ...NO_POST, exposure: -2 },
    }),
  );
  assert(white[0] >= 250 && white[1] >= 250, `exposed to white: ${white}`);
  const half = at(
    await render(renderer, scene, {
      ...flat,
      environment: { ...NO_POST, exposure: -3 },
    }),
  );
  // Linear 0.5 encodes to 188.
  assert(Math.abs(half[0] - 188) <= 8, `half exposure: ${half}`);
});

test("MSAA edges of very bright objects stay anti-aliased", async (renderer) => {
  const scene = sceneOf([draw({ emissiveStrength: 300 })]);
  const p = await render(renderer, scene, {
    background: [0, 0, 0, 1],
    environment: { tonemap: "aces", bloom: 0, vignette: 0 },
  });
  let partial = 0;
  for (let i = 0; i < p.data.length; i += 4) {
    if (p.data[i] > 25 && p.data[i] < 230) partial++;
  }
  // Plain averaging of HDR samples would saturate every edge pixel.
  assert(partial > 150, `intermediate edge pixels: ${partial}`);
});

test("bloom spreads light around an emissive object", async (renderer) => {
  const scene = sceneOf([
    draw({
      emissiveStrength: 40,
      matrix: mat4.compose([0, 0, 0], quat.fromEuler([0, 0, 0]), [
        0.5,
        0.5,
        0.5,
      ]),
    }),
  ]);
  const look = (
    env: Partial<Environment>,
    quality?: "low" | "high",
    background?: [number, number, number, number],
  ) => render(renderer, scene, { environment: env, quality, background });
  // Outside the object (radius ~0.5 of a 2.4 wide view).
  const ring = (p: PixelData) => luminance(p, 20, 20, 90, 90);
  const black: [number, number, number, number] = [0, 0, 0, 1];
  // Against a flat background the glow is added on its own...
  const off = ring(await look({ bloom: 0 }, "high", black));
  const on = ring(await look({ bloom: 0.3 }, "high", black));
  const low = ring(await look({ bloom: 0.3 }, "low", black));
  assert(on > off + 10, `glow around the object: ${off} -> ${on}`);
  assert(Math.abs(low - off) < 1, `low quality skips bloom: ${off} vs ${low}`);
  // ...and against the sky it brightens it.
  const skyOff = ring(await look({ bloom: 0 }));
  const skyOn = ring(await look({ bloom: 0.3 }));
  assert(skyOn > skyOff + 4, `glow over the sky: ${skyOff} -> ${skyOn}`);
});

test("exposure changes brightness; auto exposure steers to mid grey", async (renderer) => {
  const scene = extractScene(fixtureWorld(), catalog);
  const cam = camera();
  const mean = async (env: Partial<Environment>) =>
    luminance(
      await render(renderer, scene, { environment: env }, cam, 128),
    );
  const dark = await mean({ exposure: -1.5 });
  const mid = await mean({ exposure: 0 });
  const bright = await mean({ exposure: 1.5 });
  assert(dark < mid && mid < bright, `${dark} < ${mid} < ${bright}`);
});

test("auto exposure steers different scenes to the same mid grey", async (renderer) => {
  // Uniform emissive spheres, 60x apart in radiance; tonemap off.
  const center = async (strength: number, autoExposure: boolean) =>
    pixel(
      await render(renderer, sceneOf([draw({ emissiveStrength: strength })]), {
        background: [0, 0, 0, 1],
        environment: { ...NO_POST, autoExposure },
      }),
      S / 2,
      S / 2,
    )[1];
  const dim = await center(0.05, false);
  const bright = await center(3, false);
  assert(bright > dim + 100, `without: ${dim} vs ${bright}`);
  const autoDim = await center(0.05, true);
  const autoBright = await center(3, true);
  // Mid grey 0.18 encodes to about 118.
  assert(Math.abs(autoDim - 118) < 20, `auto dim ${autoDim}`);
  assert(Math.abs(autoBright - 118) < 20, `auto bright ${autoBright}`);
});

test("overlays are not tonemapped, exposed or bloomed", async (renderer) => {
  const scene = extractScene(fixtureWorld(), catalog);
  const green = async (env: Partial<Environment>) => {
    const p = await render(
      renderer,
      scene,
      {
        environment: env,
        lines: [{
          from: [-6, 0.02, 6],
          to: [6, 0.02, 6],
          color: [0, 1, 0, 1],
          width: 4,
        }],
      },
      camera(),
      192,
    );
    let n = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      if (p.data[i + 1] > 235 && p.data[i] < 40 && p.data[i + 2] < 40) n++;
    }
    return n;
  };
  const normal = await green({});
  assert(normal > 20, `line is drawn: ${normal}`);
  // The scene goes black at -8 EV and blows out at +8; the line is unchanged.
  assert(Math.abs((await green({ exposure: -8 })) - normal) < normal * 0.1);
  assert(Math.abs((await green({ exposure: 8 })) - normal) < normal * 0.1);
});

test("unlit and wireframe bypass the post chain", async (renderer) => {
  const scene = sceneOf([
    draw({
      mesh: "builtin:plane",
      color: [0.5, 0.25, 0.75, 1],
      emissive: [0, 0, 0, 1],
      matrix: mat4.compose([0, 0, 0], quat.fromEuler([90, 0, 0]), [8, 8, 8]),
    }),
  ]);
  const plain = await render(renderer, scene, { shading: "unlit" });
  const extreme = await render(renderer, scene, {
    shading: "unlit",
    environment: {
      exposure: 6,
      tonemap: "agx",
      vignette: 1,
      grain: 1,
      bloom: 1,
      saturation: 0,
      autoExposure: true,
    },
  });
  assertEquals(plain.data, extreme.data);
  const p = pixel(plain, S / 2, S / 2);
  assert(
    Math.abs(p[0] - 128) <= 3 && Math.abs(p[1] - 64) <= 3 &&
      Math.abs(p[2] - 191) <= 3,
    `authored colour: ${p}`,
  );
  const wire = await render(renderer, scene, { shading: "wireframe" });
  const wireExtreme = await render(renderer, scene, {
    shading: "wireframe",
    environment: { exposure: 6, tonemap: "agx", vignette: 1, grain: 1 },
  });
  assertEquals(wire.data, wireExtreme.data);
});

test("every tonemapper maps a ramp monotonically into range", async (renderer) => {
  const scene = sceneOf([draw({ emissiveStrength: 1 })]);
  for (
    const tonemap of ["aces", "agx", "neutral", "reinhard", "linear"] as const
  ) {
    const values: number[] = [];
    for (const exposure of [-6, -3, -1, 0, 2, 4]) {
      const p = await render(renderer, scene, {
        background: [0, 0, 0, 1],
        environment: { tonemap, exposure, bloom: 0, vignette: 0 },
      });
      values.push(pixel(p, S / 2, S / 2)[1]);
    }
    for (let i = 1; i < values.length; i++) {
      assert(values[i] >= values[i - 1], `${tonemap}: ${values}`);
    }
    assert(
      values[0] < 60 && values[values.length - 1] > 200,
      `${tonemap}: ${values}`,
    );
  }
});

test("a normal map changes shading, with the right handedness", async (renderer) => {
  const tilt = (x: number, y: number) => {
    const data = new Uint8Array(4 * 4 * 4);
    const z = Math.sqrt(1 - x * x - y * y);
    for (let i = 0; i < 16; i++) {
      data.set([
        Math.round((x * 0.5 + 0.5) * 255),
        Math.round((y * 0.5 + 0.5) * 255),
        Math.round((z * 0.5 + 0.5) * 255),
        255,
      ], i * 4);
    }
    return { width: 4, height: 4, data };
  };
  renderer.assets.setTexture("n/flat", tilt(0, 0));
  renderer.assets.setTexture("n/right", tilt(0.8, 0));
  renderer.assets.setTexture("n/left", tilt(-0.8, 0));
  renderer.assets.setTexture("n/up", tilt(0, 0.8));
  renderer.assets.setTexture("n/down", tilt(0, -0.8));
  // A plane in the view, lit from the right by a sun.
  const plane = (normalMap: string) =>
    draw({
      mesh: "builtin:plane",
      color: [0.8, 0.8, 0.8, 1],
      emissive: [0, 0, 0, 1],
      roughness: 1,
      normalMap,
      matrix: mat4.compose([0, 0, 0], quat.fromEuler([90, 0, 0]), [6, 6, 6]),
    });
  const sun = (dir: [number, number, number]) => ({
    entity: 9,
    kind: "directional" as const,
    color: [1, 1, 1] as [number, number, number],
    intensity: 3,
    range: 0,
    angle: 0,
    shadows: false,
    softness: 1,
    position: [0, 0, 0] as [number, number, number],
    direction: dir,
  });
  const lit = async (map: string, dir: [number, number, number]) => {
    const scene = sceneOf([plane(map)]);
    scene.lights = [sun(dir)];
    return luminance(
      await render(renderer, scene, {
        environment: { ...NO_POST, ambient: 0 },
      }),
    );
  };
  // Light travelling towards -X shines from the +X side onto the plane.
  const fromRight: [number, number, number] = [-0.7071, 0, -0.7071];
  const flat = await lit("n/flat", fromRight);
  const right = await lit("n/right", fromRight);
  const left = await lit("n/left", fromRight);
  assert(flat > 0);
  // The same map tilted towards or away from the light flips brightness; only
  // one of the pair faces the light, and the other matches no flat surface.
  assert(Math.abs(right - left) > flat * 0.3, `${left} ${flat} ${right}`);
  // Green is +Y (up the image): tilting up and down differs under vertical light.
  const fromTop: [number, number, number] = [0, -0.7071, -0.7071];
  const up = await lit("n/up", fromTop);
  const down = await lit("n/down", fromTop);
  assert(Math.abs(up - down) > 5, `${up} ${down}`);
});

test("a bump map reads as raised: lit side faces the light", async (renderer) => {
  const N = 64;
  const height = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - N / 2, y - N / 2);
      const v = Math.round(255 * Math.exp(-(d * d) / 180));
      height.set([v, v, v, 255], (y * N + x) * 4);
    }
  }
  renderer.assets.setTexture(
    "bump/normal",
    normalMapFromHeight({ width: N, height: N, data: height }, 6),
  );
  const scene = sceneOf([
    draw({
      mesh: "builtin:plane",
      color: [0.8, 0.8, 0.8, 1],
      emissive: [0, 0, 0, 1],
      normalMap: "bump/normal",
      matrix: mat4.compose([0, 0, 0], quat.fromEuler([90, 0, 0]), [3, 3, 3]),
    }),
  ]);
  // Light from the upper left of the view, towards the plane.
  scene.lights = [{
    entity: 9,
    kind: "directional",
    color: [1, 1, 1],
    intensity: 3,
    range: 0,
    angle: 0,
    shadows: false,
    softness: 1,
    position: [0, 0, 0],
    direction: [0.6, -0.6, -0.5],
  }];
  const p = await render(renderer, scene, {
    environment: { ...NO_POST, ambient: 0.2 },
  });
  const upperLeft = luminance(p, 88, 88, 124, 124);
  const lowerRight = luminance(p, 132, 132, 168, 168);
  assert(upperLeft > lowerRight + 20, `bump lit ${upperLeft} vs ${lowerRight}`);
});

test("normal and ORM maps load as linear data, colour as sRGB", (renderer) => {
  const assets = renderer.assets as unknown as Assets;
  const image = { width: 2, height: 2, data: new Uint8Array(16).fill(128) };
  renderer.assets.setTexture("data/both.png", image);
  assertEquals(
    assets.getTexture("data/both.png").texture.format,
    "rgba8unorm-srgb",
  );
  assertEquals(
    assets.getTexture("data/both.png", "normal").texture.format,
    "rgba8unorm",
  );
  assertEquals(
    assets.getTexture("data/both.png", "orm").texture.format,
    "rgba8unorm",
  );
  // Replacing the pixels updates both uploads.
  const before = assets.getTexture("data/both.png", "normal");
  renderer.assets.setTexture("data/both.png", image);
  assertNotEquals(assets.getTexture("data/both.png", "normal").id, before.id);
  // Missing data maps fall back to neutral textures, not the magenta checker.
  assertEquals(assets.getTexture(undefined, "normal"), assets.flatNormal);
  assertEquals(assets.getTexture(undefined, "orm"), assets.whiteLinear);
});

test("builtin textures load from their generators", async (renderer) => {
  const assets = renderer.assets as unknown as Assets;
  for (
    const path of [
      "builtin:checker",
      "builtin:grid",
      "builtin:noise/value",
      "builtin:noise/perlin",
      "builtin:noise/simplex",
      "builtin:noise/worley",
      "builtin:noise/fbm",
      "builtin:noise/ridged",
      "builtin:noise/blue",
    ]
  ) {
    const expected = builtinTexture(path)!;
    renderer.assets.preload("texture", path);
    // Ready immediately, no fetch: same size as the generator's image.
    assertEquals(renderer.assets.textureSize(path), [
      expected.width,
      expected.height,
    ]);
    assert(assets.getTexture(path) !== assets.white, path);
  }
  // An unknown builtin is a visible failure, like any missing texture.
  assertEquals(assets.getTexture("builtin:nope"), assets.placeholder);
  // A scene using them renders without errors and shows the pattern.
  const scene = sceneOf([
    draw({
      mesh: "builtin:plane",
      color: [1, 1, 1, 1],
      emissive: [0, 0, 0, 1],
      texture: "builtin:checker",
      uvScale: [4, 4],
      matrix: mat4.compose([0, 0, 0], quat.fromEuler([90, 0, 0]), [5, 5, 5]),
    }),
  ]);
  const p = await render(renderer, scene, { shading: "unlit" });
  const values = new Set<number>();
  for (let x = 0; x < S; x++) values.add(pixel(p, x, S / 2)[0]);
  assert(values.size >= 2, "checker shows two tones");
});

test("the blue-noise texture is shared and dithers the output", async (renderer) => {
  // A flat mid-grey surface quantises to two neighbouring levels, mixed by
  // the noise; without dither it would be a single value.
  const scene = sceneOf([
    draw({
      mesh: "builtin:plane",
      color: [0.2, 0.2, 0.2, 1],
      emissive: [0, 0, 0, 1],
      matrix: mat4.compose([0, 0, 0], quat.fromEuler([90, 0, 0]), [8, 8, 8]),
    }),
  ]);
  const p = await render(renderer, scene, { shading: "unlit" });
  const levels = new Set<number>();
  for (let y = 100; y < 156; y++) levels.add(pixel(p, 128, y)[0]);
  assert(levels.size >= 2 && levels.size <= 4, `levels ${[...levels]}`);
});

test("dense clusters keep every light beyond the old 64-light limit", async (renderer) => {
  const scene = sceneOf([
    draw({
      mesh: "builtin:plane",
      color: [1, 1, 1, 1],
      emissive: [0, 0, 0, 1],
      matrix: mat4.compose([0, 0, 0], quat.fromEuler([90, 0, 0]), [8, 8, 8]),
    }),
  ]);
  const point = (i: number) => ({
    entity: 100 + i,
    kind: "point" as const,
    color: [1, 1, 1] as [number, number, number],
    intensity: 0.1,
    range: 20,
    angle: 0,
    shadows: false,
    softness: 1,
    position: [0, 0, 2 + i * 0.01] as [number, number, number],
    direction: [0, 0, -1] as [number, number, number],
  });
  const env = { ...NO_POST, ambient: 0, exposure: -3 };
  const lit = async (count: number) => {
    scene.lights = Array.from({ length: count }, (_, i) => point(i));
    return await render(renderer, scene, { environment: env });
  };
  const few = await lit(8);
  const max = await lit(64);
  const over = await lit(80);
  assert(luminance(max) > luminance(few) * 2, "more lights, more light");
  assert(luminance(over) > luminance(max), "lights beyond 64 contribute");
  const reference = await render(renderer, scene, {
    environment: env,
    clustered: false,
  });
  assert(
    over.data.every((value, i) => value === reference.data[i]),
    "overflow uses the complete reference loop",
  );
});

test("low quality draws fewer passes than high", (renderer) => {
  const scene = extractScene(fixtureWorld(), catalog);
  // One fresh view per measurement: shadow maps and AO of an unchanged scene
  // are reused (and not counted) by a view that has drawn it before.
  const passes = (overlays: Overlays) => {
    const view = renderer.createView({ width: 256, height: 144 });
    view.render(scene, camera(), overlays);
    const count = view.stats.passes;
    view.dispose();
    return count;
  };
  const high = passes({ quality: "high" });
  const low = passes({ quality: "low" });
  const auto = passes({
    quality: "high",
    environment: { autoExposure: true },
  });
  assert(low < high && high < auto, `low ${low} high ${high} auto ${auto}`);
});

test("the lab scene renders with normal, ORM and builtin maps", async (renderer) => {
  renderer.assets.setTexture(
    "lab/fbm-normal.png",
    normalMapFromHeight(builtinTexture("builtin:noise/fbm")!, 6),
  );
  renderer.assets.setTexture(
    "lab/worley-orm.png",
    ormFromHeight(builtinTexture("builtin:noise/worley")!),
  );
  const scene = extractScene(
    labWorld({ fog_density: 0.02, auto_exposure: true }),
    labCatalog,
  );
  assert(Math.abs(scene.environment.fogDensity - 0.02) < 1e-6);
  const view = renderer.createView({ width: 320, height: 180 });
  const cam = lookAtCamera(
    [0.5, 2.6, 8.6],
    [0.4, 0.9, 0],
    { fov: 52 },
    320 / 180,
  );
  view.render(scene, cam, {});
  view.render(scene, cam, {});
  const p = await view.readPixels();
  assert(luminance(p) > 30);
  view.dispose();
});

// Sky and image-based lighting --------------------------------------------------

const sunLight = (elevation: number, azimuth = 0): LightDraw => {
  const e = (elevation * Math.PI) / 180, a = (azimuth * Math.PI) / 180;
  // Azimuth 0 puts the sun towards -z, where the sky cameras look.
  const toSun = [
    Math.cos(e) * Math.sin(a),
    Math.sin(e),
    -Math.cos(e) * Math.cos(a),
  ];
  return {
    entity: 90,
    kind: "directional",
    color: [1, 1, 1],
    intensity: 3,
    range: 0,
    angle: 0,
    shadows: false,
    softness: 1,
    position: [0, 0, 0],
    direction: [-toSun[0], -toSun[1], -toSun[2]],
  };
};
const skyScene = (light: LightDraw, draws: Draw[] = []): RenderScene => ({
  ...sceneOf(draws),
  lights: [light],
});
const lookAt = (dir: Vec3, fov = 60) =>
  lookAtCamera([0, 1.7, 0], [dir[0] * 10, 1.7 + dir[1] * 10, dir[2] * 10], {
    fov,
  }, 1);

test("the environment bakes only when the sky or the sun changes", (renderer) => {
  const scene = skyScene(sunLight(40));
  const view = renderer.createView({ width: 64, height: 64 });
  const cam = lookAt([0, 0, -1]);
  view.render(scene, cam, {});
  assertEquals(view.stats.environmentBakes, 1);
  view.render(scene, cam, {});
  view.render(scene, cam, {
    environment: { ambient: 0.3, exposure: 1, fogDensity: 0.1 },
  });
  assertEquals(
    view.stats.environmentBakes,
    1,
    "ambient, exposure and fog do not bake",
  );
  view.render(skyScene(sunLight(41)), cam, {});
  assertEquals(view.stats.environmentBakes, 2, "the sun moved");
  view.render(skyScene(sunLight(41)), cam, {
    environment: { skyIntensity: 2 },
  });
  assertEquals(view.stats.environmentBakes, 3, "sky intensity");
  view.render(skyScene(sunLight(41)), cam, {
    environment: { skyIntensity: 2, sky: "gradient" },
  });
  assertEquals(view.stats.environmentBakes, 4, "sky kind");
  view.render(skyScene(sunLight(41)), cam, {
    environment: { skyIntensity: 2, sky: "gradient" },
  });
  assertEquals(view.stats.environmentBakes, 4);
  // Unlit shows no lighting: nothing to bake, nothing counted.
  view.render(scene, cam, { shading: "unlit" });
  assertEquals(view.stats.environmentBakes, 4);
  view.dispose();
});

test("low quality spaces environment updates apart", (renderer) => {
  const view = renderer.createView({ width: 64, height: 64 });
  const cam = lookAt([0, 0, -1]);
  const low = { quality: "low" } as const;
  view.render(skyScene(sunLight(40)), cam, low);
  view.render(skyScene(sunLight(45)), cam, low);
  assertEquals(view.stats.environmentBakes, 1, "too soon after the first bake");
  for (let i = 0; i < 10; i++) view.render(skyScene(sunLight(45)), cam, low);
  assertEquals(view.stats.environmentBakes, 2, "the pending change was baked");
  view.dispose();
});

test("a metal sphere reflects the sky it is under", async (renderer) => {
  const mirror = draw({
    color: [1, 1, 1, 1],
    emissive: [0, 0, 0, 1],
    metallic: 1,
    roughness: 0.1,
  });
  const scene = sceneOf([mirror]);
  const env = (skyColor: [number, number, number, number]) => ({
    ...NO_POST,
    sky: "gradient" as const,
    skyColor,
    horizonColor: skyColor,
    groundColor: [0.05, 0.05, 0.05, 1] as [number, number, number, number],
  });
  const top = (p: PixelData) => pixel(p, S / 2, Math.floor(S * 0.38));
  const blue = top(
    await render(renderer, scene, {
      environment: env([0.1, 0.2, 1, 1]),
      background: [0, 0, 0, 1],
    }),
  );
  const red = top(
    await render(renderer, scene, {
      environment: env([1, 0.2, 0.1, 1]),
      background: [0, 0, 0, 1],
    }),
  );
  assert(blue[2] > blue[0] * 2, `blue sky reflects blue: ${blue}`);
  assert(red[0] > red[2] * 2, `red sky reflects red: ${red}`);
});

test("the sky brightens towards the sun and goes dark below the horizon", async (renderer) => {
  const view = renderer.createView({ width: 128, height: 128 });
  const grab = async (light: LightDraw, dir: Vec3) => {
    view.render(skyScene(light), lookAt(dir, 70), {
      environment: { ...NO_POST },
    });
    // Around where the sun is (12 degrees up) or would be.
    return luminance(await view.readPixels(), 44, 34, 84, 56);
  };
  const towards = await grab(sunLight(12), [0, 0, -1]);
  const away = await grab(sunLight(12), [0, 0, 1]);
  assert(towards > away * 1.15, `towards the sun ${towards}, away ${away}`);
  const night = await grab(sunLight(-30), [0, 0, -1]);
  assert(night < away * 0.4 && night < 60, `night ${night} vs day ${away}`);
  // A day sky is bluer than red at the zenith, a sunset horizon is redder.
  view.render(skyScene(sunLight(60)), lookAt([0, 1, 0.01], 40), {
    environment: { ...NO_POST },
  });
  const zenith = pixel(await view.readPixels(), 64, 64);
  assert(zenith[2] > zenith[0], `zenith ${zenith}`);
  view.render(skyScene(sunLight(1)), lookAt([0, 0.05, -1], 30), {
    environment: { ...NO_POST },
  });
  const sunset = pixel(await view.readPixels(), 20, 64);
  assert(sunset[0] > sunset[2], `sunset horizon ${sunset}`);
  view.dispose();
});

test("sun light takes the colour of the sky it comes through", () => {
  const noon = sunLightFactor(Math.PI / 2);
  assert(Math.abs(noon[0] - 1) < 1e-6 && Math.abs(noon[2] - 1) < 1e-6);
  const low = sunLightFactor((3 * Math.PI) / 180);
  assert(low[0] > low[1] && low[1] > low[2], `reddens: ${low}`);
  assert(low[0] < 1, "dims");
  const below = sunLightFactor((-5 * Math.PI) / 180);
  assertEquals(below, [0, 0, 0]);
});

test("fog thickens with distance and thins with height", async (renderer) => {
  const fog = [0.5, 0.5, 0.5, 1] as [number, number, number, number];
  const env = {
    ...NO_POST,
    fogDensity: 0.05,
    fogColor: fog,
    fogHeight: 0,
    fogFalloff: 0.25,
  };
  const glow = (z: number, y: number) =>
    draw({
      matrix: mat4.compose([0, y, z], quat.identity(), [1, 1, 1]),
      emissive: [1, 0, 0, 1],
      emissiveStrength: 2,
    });
  const cam = lookAtCamera([0, 1, 2], [0, 1, -10], { fov: 40 }, 1);
  const redness = async (z: number, y: number) => {
    const p = await render(renderer, sceneOf([glow(z, y)]), {
      environment: env,
      background: [0, 0, 0, 1],
      shading: "lit",
    }, cam);
    const px = pixel(p, S / 2, S / 2 + Math.round((S / 2) * ((1 - y) * 0.2)));
    return px;
  };
  const near = await redness(-2, 1), far = await redness(-30, 1);
  // The far sphere is mostly fog: less red and more grey.
  assert(near[0] - near[1] > far[0] - far[1] + 40, `near ${near} far ${far}`);
  // Same distance but high above the fog's ground: thinner.
  const highCam = lookAtCamera([0, 40, 2], [0, 40, -10], { fov: 40 }, 1);
  const low = await render(renderer, sceneOf([glow(-30, 1)]), {
    environment: env,
    background: [0, 0, 0, 1],
  }, cam);
  const high = await render(
    renderer,
    sceneOf([draw({
      matrix: mat4.compose([0, 40, -30], quat.identity(), [1, 1, 1]),
      emissive: [1, 0, 0, 1],
      emissiveStrength: 2,
    })]),
    { environment: env, background: [0, 0, 0, 1] },
    highCam,
  );
  const l = pixel(low, S / 2, S / 2), h = pixel(high, S / 2, S / 2);
  assert(h[0] - h[1] > l[0] - l[1] + 40, `low ${l} high ${h}`);
});
