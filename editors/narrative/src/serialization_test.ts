import { assertEquals, assertThrows } from "@std/assert";
import { narrative_evidence_id } from "./identity.ts";
import { create_narrative_starter_project } from "./presets.ts";
import {
  parse_narrative_project,
  serialize_narrative_project,
} from "./serialization.ts";

Deno.test("narrative serialization is canonical and round trips every field", () => {
  const source = serialize_narrative_project(
    create_narrative_starter_project(),
  );
  const project = parse_narrative_project(source, "starter story");
  assertEquals(serialize_narrative_project(project), source);
  assertEquals(project.scenes[0].choices[0].reveals_evidence_ids, [
    narrative_evidence_id("signal"),
  ]);
});

Deno.test("narrative parsing rejects unknown fields at the JSON boundary", () => {
  const source = JSON.parse(
    serialize_narrative_project(create_narrative_starter_project()),
  );
  source.legacy_revision = 3;
  assertThrows(
    () => parse_narrative_project(JSON.stringify(source), "legacy story"),
    Error,
    "unknown [legacy_revision]",
  );
});

Deno.test("narrative parsing reports malformed JSON and orphaned references", () => {
  assertThrows(
    () => parse_narrative_project("{", "broken story"),
    Error,
    "broken story is not valid JSON",
  );
  const source = JSON.parse(
    serialize_narrative_project(create_narrative_starter_project()),
  );
  source.scenes[0].choices[0].destination_scene_id = "missing";
  assertThrows(
    () => parse_narrative_project(JSON.stringify(source), "orphaned story"),
    Error,
    "Choice follow-signal points to missing scene missing",
  );
});
