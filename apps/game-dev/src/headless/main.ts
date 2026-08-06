import { type JsonlResponse, run_jsonl_session } from "@ink/blot/jsonl.ts";
import { load_game_development } from "../wasm_game.ts";

const game_wasm = new URL(
  "../../generated/game_development.wasm",
  import.meta.url,
);
const game_manifest = new URL(
  "../../generated/game_development.wasm.json",
  import.meta.url,
);
const [wasm_bytes, manifest_source] = await Promise.all([
  Deno.readFile(game_wasm),
  Deno.readTextFile(game_manifest),
]);
const session = await load_game_development(wasm_bytes, manifest_source);
const encoder = new TextEncoder();

await run_jsonl_session(
  session,
  Deno.stdin.readable,
  async (response: JsonlResponse) => {
    await Deno.stdout.write(
      encoder.encode(`${JSON.stringify(response)}\n`),
    );
  },
);
