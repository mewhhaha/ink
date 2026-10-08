/**
 * Records a scripted playthrough as an array of InputModel for
 * `ink run examples/hammer --inputs examples/hammer/scripts/walkthrough.json`:
 * press the first button, walk through the doors, reach the exit.
 *
 *   deno run -A examples/hammer/scripts/walkthrough.ts
 */
import { idleInput, type InputModel } from "@ink/schema";
import schema from "../schema.ts";

const inputs: InputModel[] = [];
const dt = 1 / 60;

interface Hold {
  move?: [number, number];
  turn?: [number, number];
  press?: boolean;
}

function hold(
  ticks: number,
  { move = [0, 0], turn = [0, 0], press = false }: Hold = {},
) {
  for (let i = 0; i < ticks; i++) {
    const tick = inputs.length;
    const input = idleInput(schema, tick, dt) as InputModel & {
      actions: Record<string, unknown>;
    };
    input.actions.move = move;
    input.actions.turn = turn;
    if (press && i === 0) {
      input.actions.press = { down: true, pressed: true, released: false };
    }
    inputs.push(input);
  }
}

const seconds = (s: number) => Math.round(s * 60);

hold(10);
// Room 1: to the button on the north wall, press E.
hold(42, { move: [1, 0] });
hold(72, { move: [0, 1] });
hold(10);
hold(1, { press: true });
hold(seconds(2.5)); // 0.5 s delay, then the door slides open
// Room 2: through the doorway onto the plate, to the east button.
hold(42, { move: [-1, 0] });
hold(78, { move: [0, 1] });
hold(30, { move: [1, 0] });
hold(49, { turn: [1, 0] }); // look east
hold(10);
hold(1, { press: true });
hold(seconds(2.5)); // relay, counter, door 2
// Room 3: back through the second door to the exit.
hold(49, { turn: [-1, 0] });
hold(30, { move: [-1, 0] });
hold(190, { move: [0, 1] });
hold(30);

await Deno.writeTextFile(
  new URL("./walkthrough.json", import.meta.url),
  JSON.stringify(inputs),
);
console.log(`recorded ${inputs.length} steps`);
