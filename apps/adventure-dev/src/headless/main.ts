import { parse_blot_integer_data_asset } from "@ink/blot/data_asset.ts";
import { blot_runtime_codec } from "@ink/blot/runtime.ts";
import { Observer } from "@ink/observability/observer.ts";
import { create_redacting_sink } from "@ink/observability/redaction.ts";
import { create_ring_buffer_sink } from "@ink/observability/sink.ts";
import { type JsonlResponse, run_jsonl_session } from "@ink/runtime/jsonl.ts";
import { game_adapter } from "../game_adapter.ts";
import { load_adventure_level_source } from "../level_asset.ts";

const game_wasm = new URL(
  "../../generated/adventure_development.wasm",
  import.meta.url,
);
const game_manifest = new URL(
  "../../generated/adventure_development.wasm.json",
  import.meta.url,
);
const [wasm_bytes, manifest_source, level_source] = await Promise.all([
  Deno.readFile(game_wasm),
  Deno.readTextFile(game_manifest),
  load_adventure_level_source(
    new URL("../../generated/", import.meta.url),
  ),
]);
const session = await game_adapter.create_session(wasm_bytes, manifest_source, {
  data_assets: [parse_blot_integer_data_asset(0, level_source)],
  observer: new Observer({
    source: { subsystem: "adventure-headless" },
    sink: create_redacting_sink(create_ring_buffer_sink(100)),
    clock: { now_seconds: () => performance.now() / 1_000 },
  }),
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
