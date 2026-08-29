import { blot } from "@ink/blot/adapter.ts";
import type {
  BlotPresentation,
  BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import type { GameAction } from "@ink/blot/protocol.ts";

export interface ShrubberyVoxel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly color: readonly [number, number, number];
}

export interface ShrubberyObservation {
  readonly actions: readonly {
    readonly id: string;
    readonly label: string;
    readonly action: GameAction;
  }[];
  readonly selected_name: string;
  readonly voxels: readonly ShrubberyVoxel[];
}

const shrubbery_adapter = blot({ game_id: "shrubbery" });

export async function create_shrubbery_session(
  wasm_bytes: Uint8Array,
  manifest_source: string,
): Promise<BlotRuntimeSession> {
  return await shrubbery_adapter.create_session(wasm_bytes, manifest_source);
}

export function shrubbery_observation(
  presentation: BlotPresentation,
): ShrubberyObservation {
  const scene_unit = 1_000_000;
  return {
    actions: presentation.observation.actions,
    selected_name: presentation.observation.status.label,
    voxels: presentation.snapshot.objects.map((object) => ({
      x: object.position[0] / scene_unit,
      y: (object.position[1] - object.scale[1] / 2) / scene_unit,
      z: object.position[2] / scene_unit,
      scale: object.scale[0] / scene_unit,
      color: object.color,
    })),
  };
}
