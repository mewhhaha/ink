import { assert, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import {
  create_debugger_observation_log,
  DebuggerCommandRegistry,
  type DebuggerEntry,
} from "./debugger.ts";
import { DebuggerWindow } from "./debugger_window.tsx";

Deno.test("the debugger presents retained redacted runtime observations", () => {
  const entries: DebuggerEntry[] = [];
  const observations = create_debugger_observation_log({
    capacity: 4,
    record(action) {
      entries.push({ id: entries.length, ...action });
    },
  });
  observations.record({
    type: "event",
    name: "runtime.session.initialized",
    source: { subsystem: "runtime" },
    timestamp_seconds: 1,
    context: {},
    evidence: {
      file_path: "/private/adventure.wasm",
      revision: 3,
    },
  });

  const markup = renderToStaticMarkup(
    <DebuggerWindow
      commands={new DebuggerCommandRegistry()}
      runtime_entries={entries}
      runtime_message="Ready"
      on_clear={() => {}}
      on_close={() => {}}
    />,
  );

  assertStringIncludes(markup, "runtime.session.initialized");
  assertStringIncludes(markup, "file_path=&quot;[redacted]&quot;");
  assert(!markup.includes("/private/adventure.wasm"));
});
