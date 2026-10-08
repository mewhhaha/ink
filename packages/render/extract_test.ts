import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
} from "@std/assert";
import { mat4, quat } from "@ink/geometry";
import { sceneToWorld } from "@ink/schema";
import {
  cameraFromMatrix,
  defaultEnvironment,
  extractScene,
  gameCamera,
  resolveEnvironment,
} from "./mod.ts";
import { catalog, fixtureWorld, schema } from "./fixture.ts";

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) => {
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) assertAlmostEquals(a[i], b[i], eps);
};

const world = (entities: unknown[]) =>
  sceneToWorld(schema, { ink: 1, entities } as never, catalog).world;

Deno.test("extractScene resolves the hierarchy into world matrices", () => {
  const scene = extractScene(
    world([
      {
        id: 1,
        components: { transform: { position: [10, 0, 0], scale: [2, 2, 2] } },
      },
      {
        id: 2,
        parent: 1,
        components: {
          transform: {
            position: [1, 0, 0],
            rotation: quat.fromEuler([0, 90, 0]),
          },
          mesh: { shape: "builtin:cube" },
        },
      },
      { id: 3, parent: 1, components: { mesh: { shape: "builtin:sphere" } } },
    ]),
    catalog,
  );
  near(mat4.transformPoint(scene.matrices.get(2)!, [0, 0, 0]), [12, 0, 0]);
  // The child's +X axis (length 1 in its own space) is rotated and scaled by 2.
  near(mat4.transformPoint(scene.matrices.get(2)!, [1, 0, 0]), [12, 0, -2]);
  // No transform: inherits the parent chain.
  near(scene.matrices.get(3)!, scene.matrices.get(1)!);
  assertEquals(scene.draws.map((d) => d.mesh), [
    "builtin:cube",
    "builtin:sphere",
  ]);
  assert(scene.bounds);
});

Deno.test("extractScene hides entities and their descendants", () => {
  const w = world([
    { id: 1, components: { mesh: { shape: "builtin:cube" } } },
    { id: 2, parent: 1, components: { mesh: { shape: "builtin:cube" } } },
    { id: 3, components: { mesh: { shape: "builtin:cube" } } },
  ]);
  const scene = extractScene(w, catalog, { hidden: new Set([1]) });
  assertEquals(scene.draws.map((d) => d.entity), [3]);
});

Deno.test("extractScene resolves materials, lights and cameras", () => {
  const scene = extractScene(fixtureWorld(), catalog);
  const gold = scene.draws.find((d) => d.entity === 3)!;
  assertEquals(gold.metallic, 1);
  assertEquals(gold.texture, undefined);
  assertEquals(
    scene.draws.find((d) => d.entity === 7)!.texture,
    "textures/checker.png",
  );
  const sun = scene.lights.find((l) => l.kind === "directional")!;
  assertEquals(sun.shadows, true);
  // Pitched down 50 degrees: the light travels downwards.
  assert(sun.direction[1] < -0.7);
  assertEquals(scene.cameras.length, 1);
  const camera = gameCamera(scene, 16 / 9)!;
  near(camera.position, [0, 3, 9]);
});

Deno.test("brush geometry is cached by content and split by texture", () => {
  const a = extractScene(fixtureWorld(), catalog);
  const b = extractScene(fixtureWorld(), catalog);
  assertEquals(a.brushes.length, 3);
  for (let i = 0; i < a.brushes.length; i++) {
    assert(
      a.brushes[i].geometry === b.brushes[i].geometry,
      "same geometry object",
    );
  }
  const wall = a.brushes.find((x) => x.entity === 13)!.geometry;
  // The wall's two X faces carry a texture, the other four do not.
  assertEquals(wall.parts.length, 2);
  assertNotEquals(wall.parts[0].key, wall.parts[1].key);
  const textured = wall.parts.find((p) => p.texture)!;
  assertEquals(textured.texture, "textures/checker.png");
  assertEquals(textured.mesh.faces!.length, 8);
  assertEquals(wall.polygons.length, 6);
  assertEquals(wall.edges.length, 12);
});

Deno.test("cameraFromMatrix looks down -Z", () => {
  const m = mat4.compose([0, 0, 5], quat.identity(), [1, 1, 1]);
  const cam = cameraFromMatrix(
    m,
    { fov: 60, near: 0.1, far: 100, orthographic: false, size: 10 },
    2,
  );
  const clip = mat4.transformPoint(mat4.multiply(cam.projection, cam.view), [
    0,
    0,
    0,
  ]);
  near(clip.slice(0, 2), [0, 0]);
  assert(clip[2] > 0 && clip[2] < 1);
  const behind = mat4.multiply(cam.projection, cam.view);
  assert(behind[11] !== 0);
  const ortho = cameraFromMatrix(
    m,
    { fov: 60, near: 0.1, far: 100, orthographic: true, size: 10 },
    2,
  );
  near(
    mat4.transformPoint(mat4.multiply(ortho.projection, ortho.view), [10, 5, 0])
      .slice(0, 2),
    [1, 1],
  );
});

Deno.test("environment: defaults when absent, mirror the schema when empty", () => {
  const none = extractScene(world([{ id: 1, components: {} }]), catalog);
  assertEquals(none.environment, defaultEnvironment());
  const empty = extractScene(
    world([{ id: 1, components: { environment: {} } }]),
    catalog,
  );
  // The component's schema defaults and the renderer's must not drift.
  const a = empty.environment as unknown as Record<string, unknown>;
  const b = defaultEnvironment() as unknown as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    const x = a[key], y = b[key];
    if (Array.isArray(x)) near(x as number[], y as number[], 1e-6);
    else if (typeof x === "number") assertAlmostEquals(x, y as number, 1e-6);
    else assertEquals(x, y, key);
  }
});

Deno.test("environment: the first active component wins; fields are typed", () => {
  const scene = extractScene(
    world([
      { id: 1, components: { environment: { active: false, exposure: 9 } } },
      {
        id: 2,
        components: {
          environment: {
            exposure: 1.5,
            tonemap: "agx",
            sky: "flat",
            auto_exposure: true,
            fog_density: 0.25,
            bloom: 0.5,
            horizon_color: [1, 0, 0, 1],
          },
        },
      },
      { id: 3, components: { environment: { exposure: -3 } } },
    ]),
    catalog,
  );
  const e = scene.environment;
  assertEquals(e.exposure, 1.5);
  assertEquals(e.tonemap, "agx");
  assertEquals(e.sky, "flat");
  assertEquals(e.autoExposure, true);
  assertEquals(e.fogDensity, 0.25);
  assertEquals(e.bloom, 0.5);
  assertEquals(e.horizonColor, [1, 0, 0, 1]);
  const view = resolveEnvironment(e, { exposure: 0, vignette: undefined });
  assertEquals(view.exposure, 0);
  assertEquals(view.vignette, e.vignette);
  assertEquals(e.exposure, 1.5);
});

Deno.test("extractScene carries material maps, emissive strength and light softness", () => {
  const scene = extractScene(
    world([
      {
        id: 1,
        components: {
          mesh: {
            shape: "builtin:cube",
            texture: "textures/checker.png",
            normal_map: "textures/missing.png",
            normal_strength: 2,
            orm_map: "textures/checker.png",
            emissive_strength: 8,
            uv_scale: [3, 2],
          },
        },
      },
      { id: 2, components: { light: { kind: "point", softness: 3 } } },
    ]),
    catalog,
  );
  const d = scene.draws[0];
  assertEquals(d.normalMap, "textures/missing.png");
  assertEquals(d.ormMap, "textures/checker.png");
  assertEquals(d.normalStrength, 2);
  assertEquals(d.emissiveStrength, 8);
  assertEquals(d.uvScale, [3, 2]);
  assertEquals(scene.lights[0].softness, 3);
});
