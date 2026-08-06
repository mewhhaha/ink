import { frame_id } from "@ink/runtime/frame.ts";
import { action_id, ActionEvaluator, create_action_map } from "./actions.ts";
import { control_id, device_identity } from "./model.ts";
import { SyntheticInputAdapter } from "./synthetic.ts";

const keyboard = device_identity("keyboard", "benchmark");
const controls = Array.from(
  { length: 64 },
  (_, index) => control_id(`key:Key${index}`),
);
const map_result = create_action_map({
  version: 1,
  contexts: [{
    id: "benchmark",
    priority: 0,
    consume: false,
    actions: controls.map((control, index) => ({
      id: action_id(`benchmark.action.${index}`),
      type: "digital" as const,
      bindings: [{
        id: `benchmark.binding.${index}`,
        type: "button" as const,
        control: { device_kind: "keyboard" as const, control },
      }],
    })),
  }],
});
if (!map_result.ok) throw new Error(map_result.failure.reason);
const source = new SyntheticInputAdapter();
controls.forEach((control, index) => {
  source.enqueue({
    type: "button",
    device: keyboard,
    control,
    pressed: index % 2 === 0,
  });
});
const device_frame = source.capture(frame_id(0));
const evaluator = new ActionEvaluator(map_result.value);

Deno.bench("evaluate 64 digital actions", () => {
  const frame = evaluator.evaluate(device_frame);
  if (frame.actions.length !== 64) {
    throw new Error(`evaluated ${frame.actions.length} actions`);
  }
});

Deno.bench("capture 1,000 normalized button events", () => {
  const adapter = new SyntheticInputAdapter();
  for (let index = 0; index < 1_000; index++) {
    adapter.enqueue({
      type: "button",
      device: keyboard,
      control: controls[index % controls.length],
      pressed: index % 2 === 0,
    });
  }
  const captured = adapter.capture(frame_id(0));
  if (captured.controls.length !== 64) {
    throw new Error(`captured ${captured.controls.length} controls`);
  }
});
