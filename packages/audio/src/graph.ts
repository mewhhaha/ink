import type { BusId, EffectId } from "./model.ts";

export type AudioEffect =
  | { readonly id: EffectId; readonly type: "gain"; readonly gain: number }
  | {
    readonly id: EffectId;
    readonly type: "filter";
    readonly filter: BiquadFilterType;
    readonly frequency_hz: number;
    readonly quality: number;
    readonly gain_db: number;
  }
  | {
    readonly id: EffectId;
    readonly type: "delay";
    readonly seconds: number;
    readonly feedback: number;
  }
  | {
    readonly id: EffectId;
    readonly type: "convolution";
    readonly impulse_clip: string;
    readonly wet: number;
  }
  | {
    readonly id: EffectId;
    readonly type: "dynamics";
    readonly threshold_db: number;
    readonly knee_db: number;
    readonly ratio: number;
    readonly attack_seconds: number;
    readonly release_seconds: number;
  };

export interface AudioSend {
  readonly bus: BusId;
  readonly gain: number;
}

export interface AudioBus {
  readonly id: BusId;
  readonly output?: BusId;
  readonly gain: number;
  readonly effects: readonly AudioEffect[];
  readonly sends: readonly AudioSend[];
}

export interface AudioGraphDefinition {
  readonly master: BusId;
  readonly buses: readonly AudioBus[];
}

export interface AudioGraphSnapshot {
  readonly revision: number;
  readonly master: BusId;
  readonly buses: readonly AudioBus[];
  readonly processing_order: readonly BusId[];
  readonly levels: ReadonlyMap<
    BusId,
    { readonly peak: number; readonly rms: number }
  >;
}

export type AudioGraphOperation =
  | { readonly type: "create_bus"; readonly bus: AudioBus }
  | { readonly type: "remove_bus"; readonly bus: BusId }
  | { readonly type: "replace_bus"; readonly bus: AudioBus };

export interface AudioGraphReplacement {
  readonly previous_revision: number;
  readonly snapshot: AudioGraphSnapshot;
  readonly operations: readonly AudioGraphOperation[];
}

export class AudioGraph {
  #snapshot: AudioGraphSnapshot;

  constructor(definition: AudioGraphDefinition) {
    this.#snapshot = compile_graph(definition, 0);
  }

  snapshot(): AudioGraphSnapshot {
    return copy_snapshot(this.#snapshot);
  }

  replace(definition: AudioGraphDefinition): AudioGraphReplacement {
    const next = compile_graph(definition, this.#snapshot.revision + 1);
    const previous = new Map(this.#snapshot.buses.map((bus) => [bus.id, bus]));
    const replacement = new Map(next.buses.map((bus) => [bus.id, bus]));
    const operations: AudioGraphOperation[] = [];
    for (const bus of this.#snapshot.buses) {
      if (!replacement.has(bus.id)) {
        operations.push({ type: "remove_bus", bus: bus.id });
      }
    }
    for (const bus of next.buses) {
      const old = previous.get(bus.id);
      if (old === undefined) operations.push({ type: "create_bus", bus });
      else if (JSON.stringify(old) !== JSON.stringify(bus)) {
        operations.push({ type: "replace_bus", bus });
      }
    }
    const previous_revision = this.#snapshot.revision;
    this.#snapshot = next;
    return { previous_revision, snapshot: copy_snapshot(next), operations };
  }

  record_level(bus: BusId, peak: number, rms: number): void {
    parse_level(bus, peak, "peak");
    parse_level(bus, rms, "RMS");
    if (!this.#snapshot.buses.some((candidate) => candidate.id === bus)) {
      throw new Error(
        `audio meter bus ${
          JSON.stringify(bus)
        } is not present in graph revision ${this.#snapshot.revision}`,
      );
    }
    const levels = new Map(this.#snapshot.levels);
    levels.set(bus, { peak, rms });
    this.#snapshot = { ...this.#snapshot, levels };
  }
}

export function compile_graph(
  definition: AudioGraphDefinition,
  revision = 0,
): AudioGraphSnapshot {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(
      `audio graph revision ${JSON.stringify(revision)} must be nonnegative`,
    );
  }
  if (definition.buses.length === 0) {
    throw new Error("audio graph requires at least the master bus");
  }
  const buses = new Map<BusId, AudioBus>();
  const effects = new Set<EffectId>();
  for (const original of definition.buses) {
    if (buses.has(original.id)) {
      throw new Error(
        `audio graph bus ${JSON.stringify(original.id)} appears more than once`,
      );
    }
    parse_nonnegative(original.gain, `bus ${JSON.stringify(original.id)} gain`);
    const sends = original.sends.map((send) => {
      parse_nonnegative(
        send.gain,
        `bus ${JSON.stringify(original.id)} send gain`,
      );
      return { ...send };
    });
    const bus_effects = original.effects.map((effect) => {
      if (effects.has(effect.id)) {
        throw new Error(
          `audio graph effect ${
            JSON.stringify(effect.id)
          } appears more than once`,
        );
      }
      effects.add(effect.id);
      validate_effect(effect);
      return { ...effect };
    });
    buses.set(original.id, { ...original, sends, effects: bus_effects });
  }
  const master = buses.get(definition.master);
  if (master === undefined) {
    throw new Error(
      `audio graph master bus ${JSON.stringify(definition.master)} is missing`,
    );
  }
  if (master.output !== undefined) {
    throw new Error(
      `audio graph master bus ${
        JSON.stringify(master.id)
      } cannot have an output`,
    );
  }
  for (const bus of buses.values()) {
    if (bus.id !== definition.master && bus.output === undefined) {
      throw new Error(
        `audio graph bus ${JSON.stringify(bus.id)} has no output`,
      );
    }
    if (bus.output !== undefined && !buses.has(bus.output)) {
      throw new Error(
        `audio graph bus ${JSON.stringify(bus.id)} output ${
          JSON.stringify(bus.output)
        } is missing`,
      );
    }
    for (const send of bus.sends) {
      if (!buses.has(send.bus)) {
        throw new Error(
          `audio graph bus ${JSON.stringify(bus.id)} send ${
            JSON.stringify(send.bus)
          } is missing`,
        );
      }
      if (send.bus === bus.id) {
        throw new Error(
          `audio graph bus ${JSON.stringify(bus.id)} cannot send to itself`,
        );
      }
    }
  }
  const processing_order = topological_order(buses, definition.master);
  return {
    revision,
    master: definition.master,
    buses: [...buses.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    processing_order,
    levels: new Map(),
  };
}

function topological_order(
  buses: ReadonlyMap<BusId, AudioBus>,
  master: BusId,
): readonly BusId[] {
  const state = new Map<BusId, "visiting" | "visited">();
  const order: BusId[] = [];
  const visit = (id: BusId, path: readonly BusId[]): void => {
    const current = state.get(id);
    if (current === "visited") return;
    if (current === "visiting") {
      throw new Error(
        `audio graph contains routing cycle ${[...path, id].join(" -> ")}`,
      );
    }
    state.set(id, "visiting");
    const bus = buses.get(id)!;
    const outputs = [bus.output, ...bus.sends.map((send) => send.bus)]
      .filter((output): output is BusId => output !== undefined)
      .sort((left, right) => left.localeCompare(right));
    for (const output of outputs) visit(output, [...path, id]);
    state.set(id, "visited");
    order.push(id);
  };
  for (
    const id of [...buses.keys()].sort((left, right) =>
      left.localeCompare(right)
    )
  ) visit(id, []);
  if (order.at(0) !== master) {
    throw new Error(
      `audio graph master bus ${
        JSON.stringify(master)
      } is not the final routing destination`,
    );
  }
  return order;
}

function validate_effect(effect: AudioEffect): void {
  if (effect.type === "gain") {
    parse_nonnegative(effect.gain, `effect ${JSON.stringify(effect.id)} gain`);
  } else if (effect.type === "filter") {
    parse_positive(
      effect.frequency_hz,
      `effect ${JSON.stringify(effect.id)} frequency`,
    );
    parse_nonnegative(
      effect.quality,
      `effect ${JSON.stringify(effect.id)} quality`,
    );
    parse_finite(effect.gain_db, `effect ${JSON.stringify(effect.id)} gain dB`);
  } else if (effect.type === "delay") {
    parse_nonnegative(
      effect.seconds,
      `effect ${JSON.stringify(effect.id)} delay`,
    );
    if (
      !Number.isFinite(effect.feedback) || effect.feedback < 0 ||
      effect.feedback >= 1
    ) {
      throw new Error(
        `audio effect ${JSON.stringify(effect.id)} feedback ${
          JSON.stringify(effect.feedback)
        } must be in [0, 1)`,
      );
    }
  } else if (effect.type === "convolution") {
    if (effect.impulse_clip.trim().length === 0) {
      throw new Error(
        `audio effect ${
          JSON.stringify(effect.id)
        } impulse clip cannot be empty`,
      );
    }
    if (!Number.isFinite(effect.wet) || effect.wet < 0 || effect.wet > 1) {
      throw new Error(
        `audio effect ${JSON.stringify(effect.id)} wet mix ${
          JSON.stringify(effect.wet)
        } must be in [0, 1]`,
      );
    }
  } else {
    parse_finite(
      effect.threshold_db,
      `effect ${JSON.stringify(effect.id)} threshold`,
    );
    parse_nonnegative(
      effect.knee_db,
      `effect ${JSON.stringify(effect.id)} knee`,
    );
    parse_positive(effect.ratio, `effect ${JSON.stringify(effect.id)} ratio`);
    parse_nonnegative(
      effect.attack_seconds,
      `effect ${JSON.stringify(effect.id)} attack`,
    );
    parse_nonnegative(
      effect.release_seconds,
      `effect ${JSON.stringify(effect.id)} release`,
    );
  }
}

function copy_snapshot(snapshot: AudioGraphSnapshot): AudioGraphSnapshot {
  return {
    ...snapshot,
    buses: snapshot.buses.map((bus) => ({
      ...bus,
      effects: bus.effects.map((effect) => ({ ...effect })),
      sends: bus.sends.map((send) => ({ ...send })),
    })),
    processing_order: [...snapshot.processing_order],
    levels: new Map(snapshot.levels),
  };
}

function parse_level(bus: BusId, value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `audio meter bus ${JSON.stringify(bus)} ${label} ${
        JSON.stringify(value)
      } must be in [0, 1]`,
    );
  }
}

function parse_nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `audio ${label} ${JSON.stringify(value)} must be nonnegative`,
    );
  }
}

function parse_positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`audio ${label} ${JSON.stringify(value)} must be positive`);
  }
}

function parse_finite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`audio ${label} ${JSON.stringify(value)} must be finite`);
  }
}
