import { blot_runtime_codec } from "@ink/blot/runtime.ts";
import { type JsonlResponse, run_jsonl_session } from "@ink/runtime/jsonl.ts";
import { create_platformer_session } from "../runtime.ts";

const [wasm_bytes, manifest_source] = await Promise.all([
  Deno.readFile(
    new URL("../../generated/platformer_development.wasm", import.meta.url),
  ),
  Deno.readTextFile(
    new URL(
      "../../generated/platformer_development.wasm.json",
      import.meta.url,
    ),
  ),
]);
const session = await create_platformer_session(wasm_bytes, manifest_source);
const encoder = new TextEncoder();

await run_jsonl_session(
  session,
  blot_runtime_codec,
  Deno.stdin.readable,
  async (response: JsonlResponse) => {
    await Deno.stdout.write(encoder.encode(`${JSON.stringify(response)}\n`));
  },
);
