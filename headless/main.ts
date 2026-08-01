import { Program } from "@mewhhaha/typeclasses";
import {
  close_game,
  finish_game_replay,
  type GameOperation,
  load_game,
  observe_game,
  replay_game,
  reset_game,
  run_game_program,
  save_game,
  step_game,
  trace_game,
} from "../runtime/game_effects.ts";
import { load_scene_explorer } from "../runtime/load_scene_explorer.ts";
import { type Command, parse_command } from "./command.ts";

const game_wasm = new URL("../generated/scene_explorer.wasm", import.meta.url);
const game_manifest = new URL(
  "../generated/scene_explorer.wasm.json",
  import.meta.url,
);
const [wasm_bytes, manifest_source] = await Promise.all([
  Deno.readFile(game_wasm),
  Deno.readTextFile(game_manifest),
]);
const session = await load_scene_explorer(wasm_bytes, manifest_source);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffered = "";
let should_close = false;

for await (const chunk of Deno.stdin.readable) {
  buffered += decoder.decode(chunk, { stream: true });
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    should_close = await respond_to_line(line);
    if (should_close) break;
  }
  if (should_close) break;
}

if (!should_close && buffered.trim().length > 0) {
  await respond_to_line(buffered);
}
if (!should_close) await run_game_program(close_game(), session);

async function respond_to_line(line: string): Promise<boolean> {
  let id: string | number | null = null;
  try {
    const command = parse_command(line);
    id = command.id;
    const result = await dispatch_command(command);
    await write_response({ id, ok: true, result });
    return command.command === "close";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write_response({ id, ok: false, error: message });
    return false;
  }
}

async function dispatch_command(command: Command): Promise<unknown> {
  const program = Program.scope<GameOperation>()(function* () {
    switch (command.command) {
      case "observe":
        return yield* observe_game();
      case "reset":
        return yield* reset_game();
      case "step":
        return yield* step_game(command.action, command.delta_us);
      case "save":
        return yield* save_game();
      case "load":
        return yield* load_game(command.save);
      case "finish_replay":
        return yield* finish_game_replay();
      case "replay":
        return yield* replay_game(command.replay);
      case "trace":
        return yield* trace_game();
      case "close":
        yield* close_game();
        return { closed: true };
    }
  });
  return await run_game_program(program, session);
}

async function write_response(response: unknown): Promise<void> {
  await Deno.stdout.write(encoder.encode(`${JSON.stringify(response)}\n`));
}
