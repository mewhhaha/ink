import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  open_roleplaying_session,
  play_roleplaying_session,
} from "./scenario.ts";

Deno.test("the keeper, sentinel, loot, and shrine sequence replays identically", async () => {
  const result = await play_roleplaying_session(
    await open_roleplaying_session(),
  );
  assertEquals(result.ending, "Sunken Shrine");
  assertStringIncludes(result.outcome, "healing-herb");
  assertStringIncludes(result.outcome, "5 timeline steps");
  assertEquals(result.checksum, result.replay_checksum);
});
