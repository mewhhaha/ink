/** Recorded gameplay and assertions share the editor's stepping and timeline. */
import type { InputModel, SceneFile, WorldModel } from "@ink/schema";
import { InputState } from "./input.ts";
import type { Session } from "./session.ts";

export interface ScenarioAssertion {
  /** An entity id/name, or omit to address the world's resources/header. */
  entity?: number | string;
  /** Dot-separated path, e.g. resources.score.value or components.transform.position.1. */
  path: string;
  op?: "eq" | "near" | "gt" | "gte" | "lt" | "lte";
  value: unknown;
  tolerance?: number;
}

export interface ScenarioImage {
  /** PNG under the project's scenarios directory. */
  golden: string;
  view?: string;
  width?: number;
  height?: number;
  /** Mean RGB error in 8-bit levels, default 1. */
  tolerance?: number;
}

export interface Scenario {
  ink: 1;
  name: string;
  scene?: string;
  state?: SceneFile;
  inputs?: InputModel[];
  /** Compact keyboard recording; edges are derived at each segment boundary. */
  steps?: { ticks: number; keys?: string[] }[];
  checkpoints: {
    tick: number;
    assertions?: ScenarioAssertion[];
    image?: ScenarioImage;
  }[];
}

export interface ScenarioFailure {
  tick: number;
  message: string;
  actual?: unknown;
  expected?: unknown;
  png?: string;
  diff?: string;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  tick: number;
  failures: ScenarioFailure[];
  images: {
    tick: number;
    golden: string;
    png: string;
    diff?: string;
    error: number;
  }[];
}

export function assertScenario(
  world: WorldModel,
  nameOf: (id: number) => string,
  assertion: ScenarioAssertion,
): Omit<ScenarioFailure, "tick"> | null {
  let value: unknown = assertion.entity === undefined
    ? world
    : world.entities.find((e) =>
      typeof assertion.entity === "number"
        ? e.id === assertion.entity
        : nameOf(e.id) === assertion.entity
    );
  for (const field of assertion.path.split(".")) {
    value =
      value !== null && typeof value === "object" && Object.hasOwn(value, field)
        ? (value as Record<string, unknown>)[field]
        : undefined;
  }
  const op = assertion.op ?? "eq";
  let passed = false;
  if (op === "eq") {
    passed = value !== undefined &&
      JSON.stringify(value) === JSON.stringify(assertion.value);
  } else if (typeof value === "number" && typeof assertion.value === "number") {
    switch (op) {
      case "near":
        passed =
          Math.abs(value - assertion.value) <= (assertion.tolerance ?? 1e-4);
        break;
      case "gt":
        passed = value > assertion.value;
        break;
      case "gte":
        passed = value >= assertion.value;
        break;
      case "lt":
        passed = value < assertion.value;
        break;
      case "lte":
        passed = value <= assertion.value;
        break;
    }
  }
  return passed ? null : {
    message: `${
      assertion.entity === undefined ? "world" : `entity ${assertion.entity}`
    }.${assertion.path}: expected ${op} ${
      JSON.stringify(assertion.value)
    }, got ${JSON.stringify(value)}`,
    actual: value,
    expected: assertion.value,
  };
}

export function scenarioInputs(
  session: Session,
  scenario: Scenario,
): InputModel[] {
  if (scenario.inputs) return scenario.inputs;
  const input = new InputState(session.schema);
  const out: InputModel[] = [];
  let previous = new Set<string>();
  for (const step of scenario.steps ?? []) {
    if (!Number.isSafeInteger(step.ticks) || step.ticks < 0) {
      throw new Error("scenario ticks must be nonnegative integers");
    }
    const keys = new Set(step.keys ?? []);
    for (const key of previous) if (!keys.has(key)) input.keyUp(key);
    for (const key of keys) input.keyDown(key);
    for (let i = 0; i < step.ticks; i++) {
      out.push(input.sample(out.length, session.dt, out.length * session.dt));
    }
    previous = keys;
  }
  return out;
}

export async function runScenario(
  session: Session,
  scenario: Scenario,
  image?: (
    spec: ScenarioImage,
    tick: number,
  ) => Promise<{ png: string; diff?: string; error: number }>,
): Promise<ScenarioResult> {
  if (
    scenario.ink !== 1 || !scenario.name || !Array.isArray(scenario.checkpoints)
  ) throw new Error("invalid scenario");
  if (!scenario.checkpoints.length) {
    throw new Error("scenario needs a checkpoint");
  }
  const checkpoints = [...scenario.checkpoints].sort((a, b) => a.tick - b.tick);
  if (
    checkpoints.some((c) =>
      !Number.isSafeInteger(c.tick) || c.tick < session.tick
    )
  ) throw new Error("invalid checkpoint tick");
  const inputs = scenarioInputs(session, scenario);
  session.play();
  session.pause();
  const first = session.tick;
  const result: ScenarioResult = {
    name: scenario.name,
    passed: true,
    tick: first,
    failures: [],
    images: [],
  };
  for (const checkpoint of checkpoints) {
    while (session.tick < checkpoint.tick) {
      const tick = session.tick;
      const input = inputs[tick - first];
      if (!input) {
        throw new Error(
          `scenario recording ends before checkpoint ${checkpoint.tick}`,
        );
      }
      session.stepFrame(input);
      if (session.tick !== tick + 1) {
        throw new Error(`scenario game trapped at tick ${tick}`);
      }
    }
    result.tick = session.tick;
    for (const assertion of checkpoint.assertions ?? []) {
      const failure = assertScenario(
        session.world,
        (id) => session.nameOf(id),
        assertion,
      );
      if (failure) result.failures.push({ tick: session.tick, ...failure });
    }
    if (checkpoint.image) {
      if (!image) throw new Error("scenario images require a renderer");
      const frame = await image(checkpoint.image, session.tick);
      result.images.push({
        tick: session.tick,
        golden: checkpoint.image.golden,
        ...frame,
      });
      if (frame.error > (checkpoint.image.tolerance ?? 1)) {
        result.failures.push({
          tick: session.tick,
          message: `image ${checkpoint.image.golden}: mean RGB error ${
            frame.error.toFixed(3)
          }`,
          ...frame,
        });
      }
      for (
        const failure of result.failures.filter((f) => f.tick === session.tick)
      ) {
        failure.png ??= frame.png;
        failure.diff ??= frame.diff;
      }
    }
    if (result.failures.length) {
      result.passed = false;
      const first = result.failures[0];
      const message = result.failures.map((f) => f.message).join("; ");
      session.timeline.mark({
        tick: first.tick,
        kind: "failure",
        label: `${scenario.name}: ${message}`,
        detail: { message, png: first.png, diff: first.diff },
      });
      for (const failure of result.failures) {
        session.error(
          `${scenario.name} failed at tick ${failure.tick}: ${failure.message}`,
          "scenario",
        );
      }
      return result;
    }
  }
  session.info(
    `${scenario.name}: passed ${checkpoints.length} checkpoints through tick ${session.tick}`,
    "scenario",
  );
  return result;
}
