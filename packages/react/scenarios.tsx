import { useEffect, useState } from "react";
import { createAutomation } from "./automation.ts";
import { useInk, useSessionValue } from "./context.tsx";

export function ScenarioControls() {
  const ink = useInk();
  const canStep = useSessionValue((s) => s.canStep);
  const [names, setNames] = useState<string[]>([]);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useSessionValue((s) =>
    s.log.findLast((entry) => entry.source === "scenario")
  );
  const result = latest
    ? `${latest.level === "error" ? "Failed" : "Passed"} · tick ${latest.tick}`
    : "";
  useEffect(() => {
    ink.dev?.client.scenarios().then((names) => {
      setNames(names);
      setChosen(names[0] ?? "");
    }).catch((e) => ink.session.error(String(e), "scenario"));
  }, [ink.dev]);
  if (!names.length) return null;
  return (
    <>
      <select
        aria-label="Scenario"
        value={chosen}
        disabled={busy}
        onChange={(e) => setChosen(e.target.value)}
      >
        {names.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <button
        type="button"
        className="ink-button"
        disabled={!canStep || busy}
        onClick={async () => {
          if (!ink.dev) return;
          setBusy(true);
          try {
            await createAutomation(ink, Promise.resolve())
              .scenario({
                scenario: await ink.dev.client.scenario(chosen),
              });
          } catch (error) {
            ink.session.error(String(error), "scenario");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Testing…" : "Run test"}
      </button>
      {result && !busy && (
        <output
          aria-label="Scenario result"
          style={{
            color: result.startsWith("Passed") ? "#7dff9a" : "#ff6b5e",
            fontSize: 12,
          }}
        >
          {result}
        </output>
      )}
    </>
  );
}
