/** Per-view presentation history. No previous pose is kept in game state. */
import { type Mat4, mat4 } from "@ink/geometry";
import type { GpuMesh } from "./assets.ts";
import { INSTANCE_FLOATS } from "./gpu.ts";
import type { Plan } from "./plan.ts";
import type { Camera } from "./types.ts";

function halton(index: number, base: number) {
  let value = 0, fraction = 1;
  while (index > 0) {
    fraction /= base;
    value += fraction * (index % base);
    index = Math.floor(index / base);
  }
  return value;
}

export function jitterCamera(
  camera: Camera,
  x: number,
  y: number,
  width: number,
  height: number,
): Camera {
  const projection = camera.projection.slice();
  for (let c = 0; c < 4; c++) {
    projection[c * 4] += 2 * x / width * projection[c * 4 + 3];
    projection[c * 4 + 1] -= 2 * y / height * projection[c * 4 + 3];
  }
  return { ...camera, projection };
}

interface Previous {
  data: Float32Array;
  joints: Float32Array;
  morphs: Float32Array;
  byKey: Map<string, { index: number; mesh: GpuMesh }>;
  camera: Camera;
  tick?: number;
  key: string;
}

export class TemporalHistory {
  #last?: Previous;
  #index = 0;
  get frames() {
    return Math.min(32, this.#index);
  }

  reset() {
    this.#last = undefined;
    this.#index = 0;
  }

  prepare(
    plan: Plan,
    camera: Camera,
    key: string,
    tick?: number,
    reset = false,
  ) {
    let last = this.#last;
    if (last) {
      const a = camera, b = last.camera;
      const turn = a.view[2] * b.view[2] + a.view[6] * b.view[6] +
        a.view[10] * b.view[10];
      const jump = Math.hypot(...a.position.map((v, i) => v - b.position[i]));
      const lens = [0, 5, 10, 14].some((i) =>
        Math.abs(a.projection[i] - b.projection[i]) > 0.001
      );
      reset ||= key !== last.key || turn < 0.85 ||
        jump > Math.max(2, a.far * 0.05) || lens ||
        a.orthographic !== b.orthographic ||
        (tick !== undefined && last.tick !== undefined && tick < last.tick);
    }
    if (reset) {
      this.reset();
      last = undefined;
    }
    const phase = this.#index % 8 + 1;
    const jitter: [number, number] = [
      halton(phase, 2) - 0.5,
      halton(phase, 3) - 0.5,
    ];
    const previous = new Float32Array(plan.data.length);
    const words = new Uint32Array(previous.buffer);
    const joints = plan.joints, morphs = plan.morphs;
    for (let i = 0; i < plan.instanceCount; i++) {
      const old = last?.byKey.get(plan.instanceKeys[i]);
      const valid = old && old.mesh === plan.instanceMeshes[i];
      const at = i * INSTANCE_FLOATS;
      if (valid && last) {
        previous.set(
          last.data.subarray(
            old.index * INSTANCE_FLOATS,
            (old.index + 1) * INSTANCE_FLOATS,
          ),
          at,
        );
        words[at + 44] += joints.length / 32;
        words[at + 52] += morphs.length;
        words[at + 53] += morphs.length;
      } else previous.set(plan.data.subarray(at, at + INSTANCE_FLOATS), at);
      // This copy is consumed only by the velocity shader. Flag newly visible
      // or replaced geometry so it cannot accept an unrelated surface's history.
      words[at + 41] = valid ? 0 : 1;
    }
    if (last) {
      const append = (a: Float32Array, b: Float32Array) => {
        const data = new Float32Array(a.length + b.length);
        data.set(a);
        data.set(b, a.length);
        return data;
      };
      plan.joints = append(joints, last.joints);
      plan.morphs = append(morphs, last.morphs);
    }
    const previousCamera = last?.camera ?? camera;
    this.#last = {
      // Save just this frame's palettes, not the appended preceding frame.
      data: plan.data,
      joints,
      morphs,
      key,
      tick,
      byKey: new Map(
        plan.instanceKeys.map((
          k,
          i,
        ) => [k, { index: i, mesh: plan.instanceMeshes[i] }]),
      ),
      camera: {
        ...camera,
        view: camera.view.slice(),
        projection: camera.projection.slice(),
        position: [...camera.position],
      },
    };
    this.#index++;
    return { previous, previousCamera, jitter, valid: !!last };
  }
}

export const viewProjection = (camera: Camera): Mat4 =>
  mat4.multiply(camera.projection, camera.view);
