/** Entity I/O vocabulary shared by the Outputs panel, the views and the log. */
import type { EntityModel, WorldModel } from "@ink/schema";
import { ioEvents, ioInputs } from "../schema.ts";

export type IoEvent = (typeof ioEvents)[number];
export type IoInput = (typeof ioInputs)[number];

export interface Connection {
  event: IoEvent;
  target: number;
  input: IoInput;
  delay: number;
  once: boolean;
  fired: boolean;
}

export { ioEvents, ioInputs };

/** `on_start_touch` -> `OnStartTouch`, as Hammer writes outputs. */
export const pretty = (name: string) =>
  name.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join("");

export const connectionsOf = (entity: EntityModel | undefined): Connection[] =>
  ((entity?.components.outputs as { connections?: Connection[] } | undefined)
    ?.connections) ?? [];

/** Events an entity class can raise; the rest stay available under "Other". */
export function eventsFor(entity: EntityModel | undefined): IoEvent[] {
  const c = entity?.components ?? {};
  const out: IoEvent[] = [];
  if (c.push_button) out.push("on_pressed");
  if (c.trigger_zone) out.push("on_start_touch", "on_end_touch");
  if (c.door) out.push("on_opened", "on_closed");
  if (c.relay) out.push("on_trigger");
  if (c.counter) out.push("on_hit_max");
  return out;
}

/** Inputs an entity class understands. */
export function inputsFor(entity: EntityModel | undefined): IoInput[] {
  const c = entity?.components ?? {};
  const out: IoInput[] = [];
  if (c.door) out.push("open", "close", "toggle");
  if (c.lamp) out.push("turn_on", "turn_off", "toggle");
  if (c.relay) out.push("trigger", "enable", "disable");
  if (c.counter) out.push("increment", "reset");
  if (c.trigger_zone || c.push_button) out.push("enable", "disable");
  out.push("end_level");
  return [...new Set(out)];
}

export const defaultConnection = (
  source: EntityModel | undefined,
): Connection => ({
  event: eventsFor(source)[0] ?? "on_trigger",
  target: 0,
  input: "toggle",
  delay: 0,
  once: false,
  fired: false,
});

/** Every connection in the world that points at `id`. */
export function incoming(world: WorldModel, id: number) {
  const out: { source: EntityModel; index: number; connection: Connection }[] =
    [];
  for (const source of world.entities) {
    connectionsOf(source).forEach((connection, index) => {
      if (connection.target === id) out.push({ source, index, connection });
    });
  }
  return out;
}

/** One line for the console: `button1 OnPressed → door1 Open (after 0.5s)`. */
export function describe(
  names: (id: number) => string,
  event: {
    source: number;
    event: number;
    target: number;
    input: number;
    delay: number;
  },
) {
  const delay = event.delay > 0
    ? ` (after ${Math.round(event.delay * 100) / 100}s)`
    : "";
  return `${names(event.source)} ${
    pretty(ioEvents[Math.round(event.event)] ?? "?")
  } → ${names(event.target)} ${
    pretty(ioInputs[Math.round(event.input)] ?? "?")
  }${delay}`;
}

/** The colour of a wire, by what it tells its target (sRGB 0..1). */
export const inputColor = (
  input: IoInput,
): [number, number, number, number] => {
  switch (input) {
    case "open":
    case "turn_on":
    case "enable":
      return [0.35, 0.85, 0.5, 1];
    case "close":
    case "turn_off":
    case "disable":
      return [0.95, 0.4, 0.4, 1];
    case "toggle":
      return [0.95, 0.8, 0.3, 1];
    case "end_level":
      return [0.85, 0.5, 0.95, 1];
    default:
      return [0.4, 0.7, 1, 1];
  }
};

export const css = (c: readonly number[], alpha = c[3]) =>
  `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${
    Math.round(c[2] * 255)
  }, ${alpha})`;
