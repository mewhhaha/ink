import { bus_id, command_batch, stream_id } from "@ink/audio/model.ts";
import { clamp } from "@ink/math/scalar.ts";

export type ChoiceCueResult =
  | { readonly type: "played"; readonly context_state: AudioContextState }
  | { readonly type: "unavailable"; readonly reason: string };

export interface ChoiceCue {
  play(): Promise<ChoiceCueResult>;
  close(): Promise<void>;
}

export function create_choice_cue(
  create_context: () => AudioContext = () => new AudioContext(),
): ChoiceCue {
  let context: AudioContext | undefined;
  return {
    async play() {
      try {
        context ??= create_context();
        await context.resume();
        const batch = command_batch([{
          type: "play",
          sequence: 0,
          presentation_time_seconds: 0,
          source: { type: "stream", id: stream_id("narrative-choice") },
          bus: bus_id("dialogue"),
          gain: 0.2,
          pitch: 1,
          priority: 1,
          fade_seconds: 0,
        }]);
        const command = batch.commands[0];
        if (command === undefined || command.type !== "play") {
          throw new Error("narrative choice audio plan has no play command");
        }
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 440 * command.pitch;
        gain.gain.value = clamp(command.gain, 0, 1);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.06);
        return { type: "played", context_state: context.state };
      } catch (error) {
        return {
          type: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async close() {
      if (context !== undefined && context.state !== "closed") {
        await context.close();
      }
      context = undefined;
    },
  };
}
