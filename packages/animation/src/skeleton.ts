import type { AssetId } from "@ink/assets/identity.ts";
import type { Mat4 } from "@ink/math/matrix.ts";
import { mat4_identity } from "@ink/math/matrix.ts";
import type { Transform } from "@ink/math/transform.ts";

declare const joint_id_brand: unique symbol;
export type JointId = string & { readonly [joint_id_brand]: true };

export interface RetargetJoint {
  readonly semantic: string;
  readonly translation_scale?: number;
}

export interface SkeletonJointSource {
  readonly id: string;
  readonly parent?: string;
  readonly bind_transform: Transform;
  readonly inverse_bind_matrix?: Mat4;
  readonly retarget?: RetargetJoint;
}

export interface SkeletonJoint {
  readonly id: JointId;
  readonly index: number;
  readonly parent: number | null;
  readonly bind_transform: Transform;
  readonly inverse_bind_matrix: Mat4;
  readonly retarget?: RetargetJoint;
}

export interface Skeleton {
  readonly asset: AssetId<"skeleton">;
  readonly joints: readonly SkeletonJoint[];
  readonly joint_indices: ReadonlyMap<JointId, number>;
}

export function joint_id(source: string): JointId {
  const id = source.trim();
  if (id.length === 0) {
    throw new Error(
      `animation joint id ${JSON.stringify(source)} cannot be empty`,
    );
  }
  return id as JointId;
}

export function create_skeleton(
  asset: AssetId<"skeleton">,
  sources: readonly SkeletonJointSource[],
): Skeleton {
  const indices = new Map<JointId, number>();
  const joints: SkeletonJoint[] = [];
  for (const [index, source] of sources.entries()) {
    const id = joint_id(source.id);
    if (indices.has(id)) {
      throw new Error(`skeleton ${asset} repeats joint ${JSON.stringify(id)}`);
    }
    const parent_id = source.parent === undefined
      ? undefined
      : joint_id(source.parent);
    const parent_index = parent_id === undefined
      ? undefined
      : indices.get(parent_id);
    if (parent_id !== undefined && parent_index === undefined) {
      throw new Error(
        `skeleton ${asset} joint ${id} parent ${parent_id} must precede its child`,
      );
    }
    const parent: number | null = parent_index ?? null;
    indices.set(id, index);
    joints.push(Object.freeze({
      id,
      index,
      parent,
      bind_transform: source.bind_transform,
      inverse_bind_matrix: source.inverse_bind_matrix ?? mat4_identity(),
      ...(source.retarget === undefined
        ? {}
        : { retarget: parse_retarget(asset, id, source.retarget) }),
    }));
  }
  return Object.freeze({
    asset,
    joints: Object.freeze(joints),
    joint_indices: indices,
  });
}

export function require_joint(
  skeleton: Skeleton,
  id: JointId,
  context: string,
): number {
  const index = skeleton.joint_indices.get(id);
  if (index === undefined) {
    throw new Error(
      `${context} references missing skeleton ${skeleton.asset} joint ${id}`,
    );
  }
  return index;
}

function parse_retarget(
  asset: AssetId<"skeleton">,
  id: JointId,
  source: RetargetJoint,
): RetargetJoint {
  const semantic = source.semantic.trim();
  if (semantic.length === 0) {
    throw new Error(
      `skeleton ${asset} joint ${id} retarget semantic cannot be empty`,
    );
  }
  const scale = source.translation_scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(
      `skeleton ${asset} joint ${id} retarget scale ${scale} must be positive`,
    );
  }
  return Object.freeze({ semantic, translation_scale: scale });
}
