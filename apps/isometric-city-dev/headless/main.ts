import { run_jsonl_session } from "@ink/engine/jsonl.ts";
import { load_isometric_city } from "../src/wasm_game.ts";

const generated_directory = new URL("../generated/", import.meta.url);
const [wasm_bytes, manifest_source] = await Promise.all([
  Deno.readFile(new URL("isometric_city.wasm", generated_directory)),
  Deno.readTextFile(new URL("isometric_city.wasm.json", generated_directory)),
]);
const session = await load_isometric_city(wasm_bytes, manifest_source);
const encoder = new TextEncoder();

await run_jsonl_session(
  session,
  Deno.stdin.readable,
  async (response) => {
    await Deno.stdout.write(encoder.encode(`${JSON.stringify(response)}\n`));
  },
);
