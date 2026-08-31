import {
  parse_roleplaying_project,
  serialize_roleplaying_project,
} from "@ink/roleplaying-editor/serialization.ts";
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { add_roleplaying_loot_entry, move_roleplaying_actor } from "./edit.ts";
import { compile_roleplaying_project } from "./project.ts";

const application_directory = new URL("../", import.meta.url);

Deno.test("role-playing compiler resolves the authored pilgrimage graph", async () => {
  const source = parse_roleplaying_project(
    await Deno.readTextFile(
      new URL("projects/starter.json", application_directory),
    ),
  );
  const edited = add_roleplaying_loot_entry(
    source,
    "ruins-cache",
    "moonstone-relic",
  );
  const compiled = compile_roleplaying_project(
    serialize_roleplaying_project(edited),
  );

  assertStringIncludes(
    compiled.blot_source,
    '.loot_entry = "moonstone-relic";',
  );
  assertStringIncludes(compiled.blot_source, ".player_attack_damage = 2;");
  assertStringIncludes(compiled.blot_source, ".player_region = 0;");
  assertStringIncludes(compiled.blot_source, ".sentinel_maximum_health = 4;");
  assertStringIncludes(compiled.blot_source, ".sentinel_region = 1;");
  assertStringIncludes(
    compiled.blot_source,
    ".timeline_duration_us = 1500000;",
  );
  assertStringIncludes(compiled.blot_source, ".dialogue_beat_order = 0;");
  assertStringIncludes(
    compiled.blot_source,
    ".dialogue_beat_time_us = 250000;",
  );
  assertStringIncludes(compiled.blot_source, ".loot_beat_order = 3;");
  assertStringIncludes(compiled.blot_source, ".loot_beat_time_us = 1250000;");
  assertStringIncludes(compiled.blot_source, ".quest_beat_order = 5;");
  assertStringIncludes(compiled.blot_source, ".quest_beat_time_us = 1500000;");
  assertStringIncludes(
    compiled.blot_source,
    "const project :: Int -> RoleplayingProject",
  );
  assertEquals(
    parse_roleplaying_project(compiled.canonical_source).loot[0].entries,
    ["healing-herb", "moonstone-relic"],
  );

  const ambiguous = JSON.parse(compiled.canonical_source);
  ambiguous.encounters.push({
    ...ambiguous.encounters[0],
    id: "second-ruins-guard",
  });
  assertThrows(
    () => compile_roleplaying_project(JSON.stringify(ambiguous)),
    Error,
    "region ruins encounter count 2 must be 1",
  );
});

Deno.test("role-playing compiler preserves authored timeline timing and rejects a causal reorder", async () => {
  const source = parse_roleplaying_project(
    await Deno.readTextFile(
      new URL("projects/starter.json", application_directory),
    ),
  );
  const delayed = JSON.parse(serialize_roleplaying_project(source));
  delayed.timeline.beats[0].time_us = 300_000;
  const compiled = compile_roleplaying_project(JSON.stringify(delayed));
  assertStringIncludes(
    compiled.blot_source,
    ".dialogue_beat_time_us = 300000;",
  );

  const reordered = JSON.parse(serialize_roleplaying_project(source));
  const dialogue = reordered.timeline.beats[0];
  const travel = reordered.timeline.beats[1];
  reordered.timeline.beats[0] = { ...travel, time_us: 250_000 };
  reordered.timeline.beats[1] = { ...dialogue, time_us: 500_000 };
  assertThrows(
    () => compile_roleplaying_project(JSON.stringify(reordered)),
    Error,
    "dialogue beat keeper-greeting order 1 must be 0",
  );
});

Deno.test("role-playing compiler emits authored player and sentinel regions", async () => {
  const source = parse_roleplaying_project(
    await Deno.readTextFile(
      new URL("projects/starter.json", application_directory),
    ),
  );
  const moved_player = compile_roleplaying_project(
    serialize_roleplaying_project(
      move_roleplaying_actor(source, "hero", "ruins"),
    ),
  );
  const moved_sentinel = compile_roleplaying_project(
    serialize_roleplaying_project(
      move_roleplaying_actor(source, "sentinel", "village"),
    ),
  );

  assertStringIncludes(moved_player.blot_source, ".player_region = 1;");
  assertStringIncludes(moved_player.blot_source, ".sentinel_region = 1;");
  assertStringIncludes(moved_sentinel.blot_source, ".player_region = 0;");
  assertStringIncludes(moved_sentinel.blot_source, ".sentinel_region = 0;");
});
