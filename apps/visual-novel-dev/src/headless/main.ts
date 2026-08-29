import { play_generated_narrative } from "./scenario.ts";

const outcomes = await play_generated_narrative();
await Deno.stdout.write(
  new TextEncoder().encode(`${JSON.stringify(outcomes)}\n`),
);
