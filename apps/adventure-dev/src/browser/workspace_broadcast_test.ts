import { assertEquals, assertThrows } from "@std/assert";
import {
  parse_workspace_message,
  workspace_channel_name,
} from "./workspace_broadcast.ts";

Deno.test("adventure workspace parses transport, game, and preview actions", () => {
  assertEquals(
    parse_workspace_message({ type: "transport", action: { type: "play" } }),
    { type: "transport", action: { type: "play" } },
  );
  assertEquals(
    parse_workspace_message({
      type: "game_action",
      action: { type: "custom", kind: 12, target: 0, value: 1 },
    }),
    {
      type: "game_action",
      action: { type: "custom", kind: 12, target: 0, value: 1 },
    },
  );
  assertEquals(
    parse_workspace_message({
      type: "preview_update",
      action: { type: "custom", kind: 40, target: 2, value: 18 },
    }),
    {
      type: "preview_update",
      action: { type: "custom", kind: 40, target: 2, value: 18 },
    },
  );
  assertEquals(
    workspace_channel_name("platformer"),
    "ink-adventure-development:platformer",
  );
});

Deno.test("workspace messages reject malformed commands at the boundary", () => {
  assertThrows(
    () =>
      parse_workspace_message({ type: "transport", action: { type: "seek" } }),
    Error,
    'transport action type "seek" is unsupported',
  );
  assertThrows(
    () =>
      parse_workspace_message({
        type: "preview_update",
        action: { type: "tick" },
      }),
    Error,
    'workspace game action type "tick" is unsupported',
  );
  assertThrows(
    () => workspace_channel_name("  "),
    Error,
    'workspace id "  " must not be empty',
  );
});
