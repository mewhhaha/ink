import { assertEquals, assertRejects } from "@std/assert";
import type { GameAction } from "@ink/blot/protocol.ts";
import type { GizmoVisibility } from "./debugger.ts";
import { create_game_debugger_registry } from "./game_debugger.ts";
import type { EditorAction } from "./logic.ts";

Deno.test("game debugger executes built-in and registered commands", async () => {
  const game_actions: GameAction[] = [];
  const transport_actions: EditorAction[] = [];
  let visibility: GizmoVisibility = "none";
  const registry = create_game_debugger_registry({
    additional_commands: [{
      name: "spawn",
      usage: "spawn <name>",
      description: "Spawn a fixture.",
      execute: (arguments_) => `spawned ${arguments_.join(" ")}`,
    }],
    dispatch_game_action(action) {
      game_actions.push(action);
      return Promise.resolve();
    },
    dispatch_transport(action) {
      transport_actions.push(action);
      return Promise.resolve();
    },
    read_status: () => "ready",
    set_gizmo_visibility(next) {
      visibility = next;
    },
  });

  assertEquals(await registry.execute("activate 12"), "ready");
  assertEquals(await registry.execute("play"), "transport play");
  assertEquals(await registry.execute("gizmos areas"), "gizmos areas");
  assertEquals(
    await registry.execute('spawn "red barrel"'),
    "spawned red barrel",
  );
  assertEquals(game_actions, [{ type: "activate", target: 12 }]);
  assertEquals(transport_actions, [{ type: "play" }]);
  assertEquals(visibility, "areas");
  assertEquals(registry.completions("gizmos c"), ["collisions"]);
});

Deno.test("game debugger rejects malformed built-in arguments with evidence", async () => {
  const registry = create_game_debugger_registry({
    dispatch_game_action: () => Promise.resolve(),
    dispatch_transport: () => Promise.resolve(),
    read_status: () => "ready",
    set_gizmo_visibility() {},
  });

  await assertRejects(
    () => registry.execute("focus tile-4"),
    Error,
    'target "tile-4" must be a nonnegative integer',
  );
  await assertRejects(
    () => registry.execute("gizmos maybe"),
    Error,
    'gizmo visibility "maybe" must be all, none, collisions, or areas',
  );
});
