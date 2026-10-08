/**
 * Feel Lab: a tuning bench for a side-view runner. Most of this editor is
 * game-specific UI built on Ink's hooks: sliders generated from the runner's
 * schema, presets, numbers derived from the tuning, a predicted jump arc and
 * a trail drawn into the game view, and live plots of the motion. Everything
 * works while the game runs; rewind with the timeline to compare.
 */
import { useEffect, useRef, useState } from "react";
import type { Transaction } from "@ink/core";
import type { Line } from "@ink/render";
import type { Vec3 } from "@ink/geometry";
import {
  Brand,
  BuildStatus,
  CollaborateButtons,
  Console,
  createSchemaHooks,
  HistoryButtons,
  InkApp,
  Inspector,
  LanguageSelect,
  LayoutButton,
  Outliner,
  Pane,
  Panel,
  PlayControls,
  SaveButton,
  ScenarioControls,
  Spacer,
  Split,
  Timeline,
  TopBar,
  useMessages,
  useSession,
  useSessionValue,
  Viewport,
  type ViewportContext,
  Workspace,
} from "@ink/react";
import type { Message, World } from "../game/schema.gen.ts";
const { useResource } = createSchemaHooks<World>();

type Runner = Record<string, number | number[] | boolean>;

const presets: Record<string, Partial<Record<string, number>>> = {
  Snappy: {
    run_speed: 9,
    ground_accel: 140,
    friction: 120,
    air_accel: 70,
    jump_speed: 14,
    jump_cut: 0.4,
    rise_gravity: 40,
    fall_gravity: 80,
    max_fall: 26,
    coyote: 0.1,
    buffer: 0.12,
  },
  Floaty: {
    run_speed: 6,
    ground_accel: 30,
    friction: 20,
    air_accel: 15,
    jump_speed: 10,
    jump_cut: 0.8,
    rise_gravity: 14,
    fall_gravity: 18,
    max_fall: 10,
    coyote: 0.2,
    buffer: 0.2,
  },
  Heavy: {
    run_speed: 7,
    ground_accel: 50,
    friction: 90,
    air_accel: 20,
    jump_speed: 15,
    jump_cut: 0.6,
    rise_gravity: 55,
    fall_gravity: 95,
    max_fall: 35,
    coyote: 0.05,
    buffer: 0.08,
  },
};

/** The first entity with a runner, and its runner component. */
function useRunner(): { id: number; runner: Runner; position: Vec3 } | null {
  return useSessionValue(
    (s) => {
      const e = s.world.entities.find((x) => x.components.runner);
      if (!e) return null;
      return {
        id: e.id,
        runner: e.components.runner as Runner,
        position: (e.components.transform?.position ?? [0, 0, 0]) as Vec3,
      };
    },
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );
}

/** Sliders for every tuning field, generated from the schema's metadata. */
function FeelPanel() {
  const session = useSession();
  const found = useRunner();
  const record = useSessionValue((s) => s.schema.component("runner"));
  const tx = useRef<Transaction | null>(null);
  if (!found || !record) {
    return <div className="ink-empty">No runner in the scene.</div>;
  }
  const { id, runner } = found;
  const set = (
    patch: Record<string, number>,
    label: string,
    final: boolean,
  ) => {
    const recipe = (
      world: {
        entities: {
          id: number;
          components: Record<string, Record<string, unknown>>;
        }[];
      },
    ) => {
      const e = world.entities.find((x) => x.id === id);
      if (e) Object.assign(e.components.runner, patch);
    };
    if (!final) {
      tx.current ??= session.begin(label);
      tx.current.update(recipe as never);
    } else if (tx.current) {
      tx.current.update(recipe as never);
      tx.current.commit();
      tx.current = null;
    } else session.edit(label, recipe as never);
  };
  const groups = ["Run", "Jump", "Gravity", "Forgiveness"];
  return (
    <div style={{ padding: "8px 12px 16px" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {Object.entries(presets).map(([name, values]) => (
          <button
            type="button"
            key={name}
            className="ink-button"
            data-variant="outline"
            style={{ flex: 1 }}
            onClick={() =>
              set(values as Record<string, number>, `${name} preset`, true)}
          >
            {name}
          </button>
        ))}
      </div>
      {groups.map((group) => (
        <div key={group} style={{ marginBottom: 10 }}>
          <div className="ink-field-group" style={{ marginBottom: 4 }}>
            {group}
          </div>
          {record.fields.filter((f) => f.node.field.group === group).map(
            ({ name, node }) => {
              const meta = node.field as {
                min?: number;
                max?: number;
                unit?: string;
                description?: string;
              };
              const value = runner[name] as number;
              const min = meta.min ?? 0, max = meta.max ?? 100;
              return (
                <label
                  key={name}
                  title={meta.description}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "92px 1fr 64px",
                    gap: 8,
                    alignItems: "center",
                    height: 26,
                  }}
                >
                  <span className="ink-field-label">
                    {name.replace(/_/g, " ")}
                  </span>
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={(max - min) / 200}
                    value={value}
                    style={{ accentColor: "var(--ink-accent)" }}
                    onChange={(e) =>
                      set(
                        { [name]: Number(e.target.value) },
                        `Tune ${name}`,
                        false,
                      )}
                    onPointerUp={(e) =>
                      set(
                        {
                          [name]: Number((e.target as HTMLInputElement).value),
                        },
                        `Tune ${name}`,
                        true,
                      )}
                    onKeyUp={(e) =>
                      set(
                        {
                          [name]: Number((e.target as HTMLInputElement).value),
                        },
                        `Tune ${name}`,
                        true,
                      )}
                  />
                  <span
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      textAlign: "right",
                      color: "var(--ink-muted)",
                    }}
                  >
                    {Math.round(value * 100) / 100}
                    <span style={{ color: "var(--ink-faint)", fontSize: 10 }}>
                      {meta.unit ?? ""}
                    </span>
                  </span>
                </label>
              );
            },
          )}
        </div>
      ))}
      <Derived runner={runner} />
    </div>
  );
}

/** What the tuning means, worked out from the numbers. */
function Derived({ runner }: { runner: Runner }) {
  const n = (k: string) => runner[k] as number;
  const apex = n("jump_speed") ** 2 / (2 * n("rise_gravity"));
  const rise = n("jump_speed") / n("rise_gravity");
  const fall = Math.sqrt((2 * apex) / n("fall_gravity"));
  const tapSpeed = n("jump_speed") * n("jump_cut");
  const tap = tapSpeed ** 2 / (2 * n("rise_gravity"));
  const rows: [string, string][] = [
    ["Jump height", `${apex.toFixed(2)} m`],
    ["Tap height", `${tap.toFixed(2)} m`],
    ["Air time", `${(rise + fall).toFixed(2)} s`],
    ["Jump distance", `${((rise + fall) * n("run_speed")).toFixed(1)} m`],
    ["To full speed", `${(n("run_speed") / n("ground_accel")).toFixed(2)} s`],
    [
      "Stop distance",
      `${(n("run_speed") ** 2 / (2 * n("friction"))).toFixed(2)} m`,
    ],
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "3px 8px",
        padding: 10,
        background: "var(--ink-raised)",
        borderRadius: 8,
      }}
    >
      {rows.map(([k, v]) => [
        <span key={`${k}-k`} style={{ color: "var(--ink-muted)" }}>{k}</span>,
        <span
          key={`${k}-v`}
          style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}
        >
          {v}
        </span>,
      ])}
    </div>
  );
}

interface Sample {
  tick: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Recent runner samples, one per step while playing. */
function useSamples(limit = 240): Sample[] {
  const session = useSession();
  const [samples, setSamples] = useState<Sample[]>([]);
  useEffect(() => {
    let last = -1;
    let buffer: Sample[] = [];
    return session.subscribe(() => {
      if (session.mode !== "play") {
        if (buffer.length) setSamples(buffer = []);
        last = -1;
        return;
      }
      const tick = session.tick;
      if (tick === last) return;
      if (tick < last) buffer = buffer.filter((s) => s.tick < tick);
      last = tick;
      const e = session.world.entities.find((x) => x.components.runner);
      if (!e) return;
      const p = e.components.transform?.position as number[];
      const v = e.components.runner.velocity as number[];
      buffer = [...buffer, { tick, x: p[0], y: p[1], vx: v[0], vy: v[1] }]
        .slice(-limit);
      setSamples(buffer);
    });
  }, [session]);
  return samples;
}

function Plot(
  { samples, value, label, unit, color }: {
    samples: Sample[];
    value: (s: Sample) => number;
    label: string;
    unit: string;
    color: string;
  },
) {
  const width = 300, height = 70;
  const values = samples.map(value);
  const min = Math.min(0, ...values), max = Math.max(1, ...values);
  const points = values.map((v, i) =>
    `${(i / Math.max(1, values.length - 1)) * width},${
      height - ((v - min) / (max - min)) * height
    }`
  ).join(" ");
  const now = values.at(-1) ?? 0;
  return (
    <div style={{ padding: "6px 12px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          color: "var(--ink-muted)",
          fontSize: 11,
        }}
      >
        <span>{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", color }}>
          {now.toFixed(2)} {unit}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{
          width: "100%",
          height,
          display: "block",
          background: "var(--ink-input)",
          borderRadius: 6,
        }}
      >
        <line
          x1="0"
          x2={width}
          y1={height - ((0 - min) / (max - min)) * height}
          y2={height - ((0 - min) / (max - min)) * height}
          stroke="var(--ink-border-strong)"
          strokeDasharray="3 3"
        />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

function Motion() {
  const samples = useSamples();
  if (samples.length === 0) {
    return (
      <div className="ink-empty">
        Press F5 and run around: height and speed plot here.
      </div>
    );
  }
  const apex = Math.max(...samples.map((s) => s.y));
  return (
    <div>
      <Plot
        samples={samples}
        value={(s) => s.y}
        label="Height"
        unit="m"
        color="#5b9cff"
      />
      <Plot
        samples={samples}
        value={(s) => s.vx}
        label="Run speed"
        unit="m/s"
        color="#4fd18b"
      />
      <Plot
        samples={samples}
        value={(s) => s.vy}
        label="Vertical speed"
        unit="m/s"
        color="#ffb347"
      />
      <div
        style={{ padding: "2px 12px", color: "var(--ink-faint)", fontSize: 11 }}
      >
        Highest point in view: {apex.toFixed(2)} m
      </div>
    </div>
  );
}

/** Predict a jump from the runner's position with its current tuning. */
function predict(
  runner: Runner,
  from: Vec3,
  hold: boolean,
  direction: number,
): Vec3[] {
  const n = (k: string) => runner[k] as number;
  const dt = 1 / 60;
  let x = from[0], y = from[1], vy = n("jump_speed");
  const vx = n("run_speed") * direction;
  const points: Vec3[] = [[x, y, 0.5]];
  for (let i = 0; i < 300; i++) {
    if (!hold && i === 2 && vy > 0) vy *= n("jump_cut");
    const g = vy > 0 && hold ? n("rise_gravity") : n("fall_gravity");
    vy = Math.max(-n("max_fall"), vy - g * dt);
    x += vx * dt;
    y += vy * dt;
    points.push([x, y, 0.5]);
    if (y < from[1] - 3) break;
  }
  return points;
}

function polyline(
  points: Vec3[],
  color: [number, number, number, number],
  width = 2,
): Line[] {
  return points.slice(1).map((p, i) => ({
    from: points[i],
    to: p,
    color,
    width,
  }));
}

function Hud() {
  const run = useResource("run");
  const { text } = useMessages<Message>();
  return (
    <div
      style={{
        position: "absolute",
        right: 12,
        top: 10,
        display: "flex",
        gap: 8,
        fontWeight: 700,
        fontSize: 13,
      }}
    >
      <span
        style={{
          padding: "4px 10px",
          borderRadius: 999,
          background: "rgba(10,11,14,0.6)",
        }}
      >
        ⏱ {run.time.toFixed(2)} s
      </span>
      <span
        style={{
          padding: "4px 10px",
          borderRadius: 999,
          background: "rgba(10,11,14,0.6)",
        }}
      >
        ⤒ {run.jumps}
      </span>
      {run.finished && (
        <span
          style={{
            padding: "4px 10px",
            borderRadius: 999,
            background: "rgba(79,209,139,0.9)",
            color: "#06210f",
          }}
        >
          {text("goal_hud")}
        </span>
      )}
    </div>
  );
}

function GameView() {
  const found = useRunner();
  const samples = useSamples(120);
  const latest = useRef({ found, samples });
  latest.current = { found, samples };
  const overlay = (_ctx: ViewportContext): Line[] => {
    const { found, samples } = latest.current;
    if (!found) return [];
    const lines: Line[] = [];
    const direction = (found.runner.velocity as number[])[0] < -0.1 ? -1 : 1;
    lines.push(
      ...polyline(predict(found.runner, found.position, true, direction), [
        0.36,
        0.61,
        1,
        0.9,
      ]),
    );
    lines.push(
      ...polyline(predict(found.runner, found.position, false, direction), [
        1,
        0.7,
        0.28,
        0.9,
      ], 1.5),
    );
    for (let i = 1; i < samples.length; i += 2) {
      const a = samples[i - 1], b = samples[i];
      const fade = i / samples.length;
      lines.push({
        from: [a.x, a.y, 0.4],
        to: [b.x, b.y, 0.4],
        color: [1, 1, 1, 0.15 + 0.6 * fade],
        width: 3,
      });
    }
    return lines;
  };
  return (
    <Viewport id="game" view="game" label="Game" overlay={overlay} diagnostics>
      <Hud />
    </Viewport>
  );
}

export function App() {
  return (
    <InkApp project="examples/feel" title="Feel Lab" hud={<Hud />}>
      <TopBar>
        <Brand subtitle="game-feel bench" />
        <SaveButton />
        <HistoryButtons />
        <Spacer />
        <PlayControls />
        <Spacer />
        <BuildStatus />
        <LanguageSelect />
        <ScenarioControls />
        <CollaborateButtons />
        <LayoutButton />
      </TopBar>
      <Workspace>
        <Split id="columns">
          <Pane size={330} min={260}>
            <Panel title="Feel">
              <FeelPanel />
            </Panel>
          </Pane>
          <Pane>
            <Split id="center" direction="column">
              <Pane>
                <GameView />
              </Pane>
              <Pane size={240} min={120}>
                <Viewport id="level" view="front" label="Level" />
              </Pane>
              <Pane size={44} min={36}>
                <Panel>
                  <Timeline />
                </Panel>
              </Pane>
            </Split>
          </Pane>
          <Pane size={330} min={240}>
            <Split id="right" direction="column">
              <Pane size={320}>
                <Panel title="Motion">
                  <Motion />
                </Panel>
              </Pane>
              <Pane>
                <Panel
                  id="right-tabs"
                  tabs={[
                    {
                      id: "inspector",
                      label: "Inspector",
                      content: <Inspector />,
                    },
                    { id: "scene", label: "Scene", content: <Outliner /> },
                    { id: "console", label: "Console", content: <Console /> },
                  ]}
                />
              </Pane>
            </Split>
          </Pane>
        </Split>
      </Workspace>
    </InkApp>
  );
}
