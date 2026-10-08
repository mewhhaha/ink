/**
 * Spot and point light shadows. Shadow-casting local lights compete for a
 * fixed budget (8 spot + 4 point at high quality, 2 + 1 at low), ranked by how
 * much of the view they can influence (range over distance to the camera,
 * favouring lights in front of it, with hysteresis so slots do not flicker).
 * The winner's slot is written to `lights[i].extra.z`; lights without one are
 * unshadowed. See `shaders/shadows.ts` for the record layout in binding 12.
 *
 * Spot lights render a perspective depth map into a tile of one atlas
 * (binding 3); point lights render six 90 degree faces into a cube array
 * (binding 4, also bound as plain layers at 13 for the blocker search). A map
 * is only re-rendered when its light or a caster changed.
 */
import {
  type Aabb,
  aabbIsEmpty,
  type Mat4,
  mat4,
  type Vec3,
  vec3,
} from "@ink/geometry";
import { DEPTH_FORMAT, TextureUsage } from "../gpu.ts";
import { LIGHT_FLOATS } from "../shaders/frame_layout.ts";
import { drawPlan } from "../systems.ts";
import type {
  FrameContext,
  PrepareContext,
  RenderSystem,
  SystemBindings,
} from "../systems.ts";
import type { LightDraw } from "../types.ts";
import {
  casterSignature,
  hashFloats,
  mix,
  ShadowPasses,
} from "./shadow_common.ts";

export const BUDGET = {
  high: { spots: 8, points: 4, tile: 1024, cube: 512 },
  low: { spots: 2, points: 1, tile: 512, cube: 256 },
} as const;
const MAX_SPOTS = 8;
const MAX_POINTS = 4;
/** Widest cone a spot shadow tile covers, in degrees. */
const MAX_SPOT_ANGLE = 150;
const NEAR = 0.05;
/** Shadows reach at most this far (depth precision, and nothing is lit that
 * far from a light anyway). */
const MAX_FAR = 150;

/** Cube face bases in the hardware's layout: looking along `dir`, image
 * right and image up. The resulting view is mirrored (cube maps are left
 * handed), which is fine for depth with culling off. */
const FACES: { dir: Vec3; right: Vec3; up: Vec3 }[] = [
  { dir: [1, 0, 0], right: [0, 0, -1], up: [0, 1, 0] },
  { dir: [-1, 0, 0], right: [0, 0, 1], up: [0, 1, 0] },
  { dir: [0, 1, 0], right: [1, 0, 0], up: [0, 0, -1] },
  { dir: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { dir: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] },
  { dir: [0, 0, -1], right: [-1, 0, 0], up: [0, 1, 0] },
];

/** View matrix from an explicit basis (rows right, up, back). */
function basisView(eye: Vec3, right: Vec3, up: Vec3, dir: Vec3): Mat4 {
  const back: Vec3 = [-dir[0], -dir[1], -dir[2]];
  const m = new Float32Array(16);
  const rows = [right, up, back];
  rows.forEach((r, i) => {
    m[i] = r[0];
    m[4 + i] = r[1];
    m[8 + i] = r[2];
    m[12 + i] = -vec3.dot(r, eye);
  });
  m[15] = 1;
  return m;
}

interface Candidate {
  /** Index in the uploaded light list. */
  index: number;
  light: LightDraw;
  score: number;
  far: number;
}

interface SpotJob {
  slot: number;
  matrix: Mat4;
  signature: number;
}
interface PointJob {
  slot: number;
  views: Mat4[];
  signature: number;
}

function sphereHitsBounds(c: Vec3, r: number, b: Aabb): boolean {
  let d2 = 0;
  for (let k = 0; k < 3; k++) {
    const v = Math.max(b.min[k] - c[k], 0, c[k] - b.max[k]);
    d2 += v * v;
  }
  return d2 <= r * r;
}

export class LocalShadowSystem implements RenderSystem {
  readonly name = "local-shadow";
  private passes?: ShadowPasses;
  private atlas?: GPUTexture;
  private atlasView?: GPUTextureView;
  private atlasKey = "";
  private cubes?: GPUTexture;
  private cubeView?: GPUTextureView;
  private faceView?: GPUTextureView;
  private cubeFaces: GPUTextureView[] = [];
  private cubeKey = "";
  private spots: SpotJob[] = [];
  private points: PointJob[] = [];
  private bindSpot = false;
  private bindPoint = false;
  /** entity -> slot of the previous frame (hysteresis). */
  private prevSpot = new Map<number, number>();
  private prevPoint = new Map<number, number>();
  private spotSignatures: number[] = [];
  private pointSignatures: number[] = [];
  private atlasDirty = true;
  private tile = 0;
  private cols = 1;
  private rows = 1;

  prepare(ctx: PrepareContext) {
    this.spots = [];
    this.points = [];
    this.bindSpot = false;
    this.bindPoint = false;
    const { casterBounds } = ctx.frame;
    if (
      aabbIsEmpty(casterBounds) || ctx.overlays.shading === "wireframe" ||
      ctx.overlays.shading === "unlit"
    ) return;
    const budget = BUDGET[ctx.quality];
    const eye = ctx.camera.position;
    const dir = vec3.normalize([
      -ctx.camera.view[2],
      -ctx.camera.view[6],
      -ctx.camera.view[10],
    ]);
    const spots: Candidate[] = [];
    const points: Candidate[] = [];
    ctx.frame.ordered.forEach((light, index) => {
      if (light.kind === "directional" || !light.shadows) return;
      let far = light.range;
      if (far <= 0) {
        // Unlimited: out to the farthest caster corner.
        far = 1;
        for (const x of [casterBounds.min[0], casterBounds.max[0]]) {
          for (const y of [casterBounds.min[1], casterBounds.max[1]]) {
            for (const z of [casterBounds.min[2], casterBounds.max[2]]) {
              far = Math.max(far, vec3.distance(light.position, [x, y, z]));
            }
          }
        }
      }
      far = Math.min(far, MAX_FAR);
      if (!sphereHitsBounds(light.position, far, casterBounds)) return;
      const dist = vec3.distance(light.position, eye);
      const ahead = vec3.dot(vec3.sub(light.position, eye), dir) > -far;
      const prev = (light.kind === "spot" ? this.prevSpot : this.prevPoint)
        .has(light.entity);
      const score = (far / Math.max(dist, 1)) * (ahead ? 1 : 0.2) *
        (prev ? 1.25 : 1);
      (light.kind === "spot" ? spots : points).push({
        index,
        light,
        score,
        far: Math.max(far, NEAR * 10),
      });
    });

    const chooseSlots = (
      list: Candidate[],
      limit: number,
      prev: Map<number, number>,
    ) => {
      const chosen = list.sort((a, b) => b.score - a.score).slice(0, limit);
      const taken = new Set<number>();
      const slots = new Map<Candidate, number>();
      for (const c of chosen) {
        const old = prev.get(c.light.entity);
        if (old !== undefined && old < limit && !taken.has(old)) {
          taken.add(old);
          slots.set(c, old);
        }
      }
      let free = 0;
      for (const c of chosen) {
        if (slots.has(c)) continue;
        while (taken.has(free)) free++;
        taken.add(free);
        slots.set(c, free);
      }
      prev.clear();
      for (const [c, slot] of slots) prev.set(c.light.entity, slot);
      return slots;
    };

    const device = ctx.core.device;
    const spotSlots = chooseSlots(spots, budget.spots, this.prevSpot);
    const pointSlots = chooseSlots(points, budget.points, this.prevPoint);
    if (spotSlots.size) this.ensureAtlas(ctx, budget.tile, budget.spots);
    if (pointSlots.size) this.ensureCubes(ctx, budget.cube, budget.points);
    const record = new Float32Array(32);

    for (const [c, slot] of spotSlots) {
      const { light } = c;
      const half = (Math.min(Math.max(light.angle, 1), MAX_SPOT_ANGLE) / 2) *
        Math.PI / 180;
      const fov = half * 2 * 1.02;
      const tanHalf = Math.tan(fov / 2);
      const forward = vec3.normalize(light.direction);
      const view = mat4.lookAt(
        light.position,
        vec3.add(light.position, forward),
        Math.abs(forward[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0],
      );
      const matrix = mat4.multiply(
        mat4.perspective(fov, 1, NEAR, c.far),
        view,
      );
      const col = slot % this.cols, row = Math.floor(slot / this.cols);
      record.fill(0);
      record.set(matrix, 0);
      record.set([
        col / this.cols,
        row / this.rows,
        1 / this.cols,
        1 / this.rows,
      ], 16);
      record.set([NEAR, c.far, tanHalf, this.tile], 20);
      record.set([view[0], view[4], view[8]], 24);
      record.set([view[1], view[5], view[9]], 28);
      device.queue.writeBuffer(ctx.shadowMatrices, slot * 2 * 64, record);
      ctx.frame.lights[c.index * LIGHT_FLOATS + 14] = slot;
      this.spots.push({
        slot,
        matrix,
        signature: hashFloats(this.tile, matrix),
      });
    }
    for (const [c, slot] of pointSlots) {
      const { light } = c;
      const projection = mat4.perspective(Math.PI / 2, 1, NEAR, c.far);
      const views = FACES.map((f) =>
        mat4.multiply(
          projection,
          basisView(light.position, f.right, f.up, f.dir),
        )
      );
      const rec = MAX_SPOTS + slot;
      record.fill(0);
      record.set([NEAR, c.far, 0, slot], 20);
      device.queue.writeBuffer(ctx.shadowMatrices, rec * 2 * 64, record);
      ctx.frame.lights[c.index * LIGHT_FLOATS + 14] = rec;
      this.points.push({
        slot,
        views,
        signature: hashFloats(this.cubeSize(), [...light.position, c.far]),
      });
    }
    this.bindSpot = this.spots.length > 0;
    this.bindPoint = this.points.length > 0;
    if (this.bindSpot || this.bindPoint) ctx.write("systems", [1], 3);
  }

  private cubeSize(): number {
    return this.cubes?.width ?? 0;
  }

  bindings(): SystemBindings {
    return {
      spotShadow: this.bindSpot ? this.atlasView : undefined,
      pointShadow: this.bindPoint ? this.cubeView : undefined,
      pointFaces: this.bindPoint ? this.faceView : undefined,
    };
  }

  encode(ctx: FrameContext): number {
    let rendered = 0;
    const casters = casterSignature(ctx.plan);
    const draw = (pass: GPURenderPassEncoder) =>
      drawPlan(pass, ctx, {
        filter: (b) => b.castsShadows,
        material: ctx.core.assets.defaultMaterial,
      });

    if (this.spots.length) {
      let dirty = this.atlasDirty;
      const next: number[] = [];
      for (const job of this.spots) {
        next[job.slot] = mix(job.signature, casters) || 1;
        if (this.spotSignatures[job.slot] !== next[job.slot]) dirty = true;
      }
      if (dirty) {
        // Tiles of unused slots are cleared with the rest: forget them.
        this.spotSignatures = next;
        this.atlasDirty = false;
        // One pass clears the atlas and draws every tile through a viewport.
        const pass = this.passes!.begin(ctx.encoder, this.atlasView!, 0);
        for (const job of this.spots) {
          this.passes!.set(job.slot, job.matrix as Float32Array);
          const col = job.slot % this.cols,
            row = Math.floor(job.slot / this.cols);
          pass.setViewport(
            col * this.tile,
            row * this.tile,
            this.tile,
            this.tile,
            0,
            1,
          );
          pass.setScissorRect(
            col * this.tile,
            row * this.tile,
            this.tile,
            this.tile,
          );
          pass.setBindGroup(0, this.passes!.group, [job.slot * 256]);
          draw(pass);
        }
        pass.end();
        rendered++;
      }
    }

    for (const job of this.points) {
      const sig = mix(job.signature, casters) || 1;
      if (this.pointSignatures[job.slot] === sig) continue;
      this.pointSignatures[job.slot] = sig;
      job.views.forEach((m, f) => {
        const slot = MAX_SPOTS + job.slot * 6 + f;
        this.passes!.set(slot, m as Float32Array);
        const pass = this.passes!.begin(
          ctx.encoder,
          this.cubeFaces[job.slot * 6 + f],
          slot,
        );
        draw(pass);
        pass.end();
        rendered++;
      });
    }
    return rendered;
  }

  private ensureAtlas(ctx: PrepareContext, tile: number, budget: number) {
    const key = `${tile}:${budget}`;
    this.passes ??= new ShadowPasses(ctx.core, MAX_SPOTS + MAX_POINTS * 6);
    if (this.atlas && this.atlasKey === key) return;
    this.atlas?.destroy();
    this.atlasKey = key;
    this.tile = tile;
    this.cols = Math.min(4, budget);
    this.rows = Math.ceil(budget / this.cols);
    this.atlas = ctx.core.device.createTexture({
      label: "spot-shadow-atlas",
      size: [tile * this.cols, tile * this.rows],
      format: DEPTH_FORMAT,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
    });
    this.atlasView = this.atlas.createView();
    this.spotSignatures = [];
    this.atlasDirty = true;
  }

  private ensureCubes(ctx: PrepareContext, res: number, budget: number) {
    const key = `${res}:${budget}`;
    this.passes ??= new ShadowPasses(ctx.core, MAX_SPOTS + MAX_POINTS * 6);
    if (this.cubes && this.cubeKey === key) return;
    this.cubes?.destroy();
    this.cubeKey = key;
    this.cubes = ctx.core.device.createTexture({
      label: "point-shadow-cubes",
      size: [res, res, 6 * budget],
      format: DEPTH_FORMAT,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
    });
    this.cubeView = this.cubes.createView({ dimension: "cube-array" });
    this.faceView = this.cubes.createView({ dimension: "2d-array" });
    this.cubeFaces = Array.from(
      { length: 6 * budget },
      (_, i) =>
        this.cubes!.createView({
          dimension: "2d",
          baseArrayLayer: i,
          arrayLayerCount: 1,
        }),
    );
    this.pointSignatures = [];
  }

  dispose() {
    this.atlas?.destroy();
    this.cubes?.destroy();
    this.passes?.dispose();
  }
}
