import { assert, assertEquals } from "@std/assert";
import {
  close_game,
  describe_game_frame,
  run_game_program,
  step_game_frame,
} from "@ink/engine/game_effects.ts";
import type { SemanticRegion } from "@ink/engine/protocol.ts";
import { load_doom } from "./wasm_game.ts";

Deno.test("the Blot menu exposes and updates semantic controls", async () => {
  const wasm_bytes = await Deno.readFile(
    new URL("../generated/doom-menu.wasm", import.meta.url),
  );
  const manifest_source = await Deno.readTextFile(
    new URL("../generated/doom-menu.manifest.json", import.meta.url),
  );
  const session = await load_doom(wasm_bytes, manifest_source, {
    width: 960,
    height: 540,
  });

  try {
    const initial = await run_game_program(
      describe_game_frame(),
      session,
    );
    assertEquals(
      initial.observation.regions.map((region) => region.id),
      [
        "menu-cursor",
        "new-mission",
        "options",
        "quit",
      ],
    );
    assertEquals(
      selected_button(initial.observation.regions, "new-mission"),
      true,
    );
    assert(
      initial.observation.actions.some((action) =>
        action.id === "doom-menu-up"
      ),
    );
    assert(
      initial.observation.actions.some((action) =>
        action.id === "doom-menu-down"
      ),
    );

    const moved = await run_game_program(
      step_game_frame({ type: "custom", kind: 11, target: 0, value: 0 }),
      session,
    );
    assertEquals(
      selected_button(moved.observation.regions, "options"),
      true,
    );
  } finally {
    await run_game_program(close_game(), session);
  }
});

function selected_button(
  regions: readonly SemanticRegion[],
  id: string,
): boolean | undefined {
  const region = regions.find((candidate) => candidate.id === id);
  return region?.role === "button" ? region.selected : undefined;
}
