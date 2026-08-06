import { assert, assertEquals } from "@std/assert";
import type { HeadlessSession } from "@ink/blot/headless_session.ts";
import { load_game_development } from "../src/wasm_game.ts";

Deno.test("the compiled game toggles its object through the native button", async () => {
  const session = await load_test_session();

  const initial = session.describe();
  assertEquals(initial.projection, "perspective");
  assertEquals(initial.regions.map((region) => [region.role, region.label]), [
    ["button", "Toggle object"],
  ]);
  const initial_button = initial.regions[0];
  assert(initial_button.role === "button");
  assertEquals(initial_button.pressed, false);
  assertEquals(initial.status, {
    done: false,
    label: "Object state",
    value: "inactive",
  });
  assertEquals(session.render().objects.map((object) => object.mesh), [0]);

  const active = await session.step({ type: "activate", target: 0 });
  const active_button = active.regions[0];
  assert(active_button.role === "button");
  assertEquals(active_button.pressed, true);
  assertEquals(active.status, {
    done: true,
    label: "Object state",
    value: "active",
  });
  assertEquals(active.outcome, "won");
  session.close();
});

async function load_test_session(): Promise<HeadlessSession> {
  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(
      new URL("../generated/game_development.wasm", import.meta.url),
    ),
    Deno.readTextFile(
      new URL("../generated/game_development.wasm.json", import.meta.url),
    ),
  ]);
  return await load_game_development(wasm_bytes, manifest_source);
}
