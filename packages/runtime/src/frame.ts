declare const frame_id_brand: unique symbol;

export type FrameId = number & { readonly [frame_id_brand]: "FrameId" };

export interface FixedStepContext {
  readonly frame_id: FrameId;
  readonly fixed_step_sequence: number;
  readonly simulation_time_seconds: number;
  readonly delta_seconds: number;
}

export interface FrameContext {
  readonly frame_id: FrameId;
  readonly fixed_step_sequence: number;
  readonly elapsed_seconds: number;
  readonly delta_seconds: number;
  readonly interpolation: number;
}

export function frame_id(value: number): FrameId {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `frame id ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
  }
  return value as FrameId;
}
