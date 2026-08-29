import { parse_blot_integer_data_asset } from "@ink/blot/data_asset.ts";
import { blot_runtime_codec } from "@ink/blot/runtime.ts";
import { type JsonlResponse, run_jsonl_session } from "@ink/runtime/jsonl.ts";
import { game_adapter } from "../../ink.ts";

const game_wasm = new URL(
  "../../generated/dungeon_development.wasm",
  import.meta.url,
);
const game_manifest = new URL(
  "../../generated/dungeon_development.wasm.json",
  import.meta.url,
);
const [wasm_bytes, manifest_source, level_source] = await Promise.all([
  Deno.readFile(game_wasm),
  Deno.readTextFile(game_manifest),
  Deno.readTextFile(
    new URL("../../generated/assets/levels/starter.json", import.meta.url),
  ),
]);
const session = await game_adapter.create_session(wasm_bytes, manifest_source, {
  data_assets: [parse_blot_integer_data_asset(0, level_source)],
});
const encoder = new TextEncoder();

await run_jsonl_session(
  session,
  blot_runtime_codec,
  Deno.stdin.readable,
  async (response: JsonlResponse) => {
    await Deno.stdout.write(
      encoder.encode(`${JSON.stringify(response)}\n`),
    );
  },
);
