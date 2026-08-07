import {
  bus_id,
  type BusId,
  clip_id,
  type ClipId,
  effect_id,
  type EffectId,
} from "./model.ts";

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
    readonly impulse_clip: ClipId;
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
    return Object.freeze({
      previous_revision,
      snapshot: copy_snapshot(next),
      operations: Object.freeze(
        operations.map((operation) => Object.freeze(operation)),
      ),
    });
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
    levels.set(bus, Object.freeze({ peak, rms }));
    this.#snapshot = Object.freeze({ ...this.#snapshot, levels });
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
    const id = bus_id(original.id);
    if (buses.has(id)) {
      throw new Error(
        `audio graph bus ${JSON.stringify(id)} appears more than once`,
      );
    }
    parse_nonnegative(original.gain, `bus ${JSON.stringify(id)} gain`);
    const sends = original.sends.map((send) => {
      parse_nonnegative(
        send.gain,
        `bus ${JSON.stringify(id)} send gain`,
      );
      return Object.freeze({ bus: bus_id(send.bus), gain: send.gain });
    });
    const bus_effects = original.effects.map((effect) => {
      const parsed = snapshot_effect(effect);
      if (effects.has(parsed.id)) {
        throw new Error(
          `audio graph effect ${
            JSON.stringify(parsed.id)
          } appears more than once`,
        );
      }
      effects.add(parsed.id);
      validate_effect(parsed);
      return parsed;
    });
    buses.set(
      id,
      Object.freeze({
        id,
        ...(original.output === undefined
          ? {}
          : { output: bus_id(original.output) }),
        gain: original.gain,
        sends: Object.freeze(sends),
        effects: Object.freeze(bus_effects),
      }),
    );
  }
  const master_id = bus_id(definition.master);
  const master = buses.get(master_id);
  if (master === undefined) {
    throw new Error(
      `audio graph master bus ${JSON.stringify(master_id)} is missing`,
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
    if (bus.id !== master_id && bus.output === undefined) {
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
  const processing_order = topological_order(buses, master_id);
  return Object.freeze({
    revision,
    master: master_id,
    buses: Object.freeze(
      [...buses.values()].sort((left, right) =>
        left.id.localeCompare(right.id)
      ),
    ),
    processing_order: Object.freeze(processing_order),
    levels: new Map(),
  });
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
    if (!biquad_filter_types.has(effect.filter)) {
      throw new Error(
        `audio effect ${JSON.stringify(effect.id)} filter ${
          JSON.stringify(effect.filter)
        } is unsupported`,
      );
    }
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
    if (
      typeof effect.impulse_clip !== "string" ||
      effect.impulse_clip.trim().length === 0
    ) {
      throw new Error(
        `audio effect ${JSON.stringify(effect.id)} impulse clip ${
          JSON.stringify(effect.impulse_clip)
        } must be a non-empty string`,
      );
    }
    if (!Number.isFinite(effect.wet) || effect.wet < 0 || effect.wet > 1) {
      throw new Error(
        `audio effect ${JSON.stringify(effect.id)} wet mix ${
          JSON.stringify(effect.wet)
        } must be in [0, 1]`,
      );
    }
  } else if (effect.type === "dynamics") {
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
  } else {
    const malformed = effect as {
      readonly id?: unknown;
      readonly type?: unknown;
    };
    throw new Error(
      `audio effect ${JSON.stringify(malformed.id)} type ${
        JSON.stringify(malformed.type)
      } is unsupported`,
    );
  }
}

const biquad_filter_types = new Set<BiquadFilterType>([
  "lowpass",
  "highpass",
  "bandpass",
  "lowshelf",
  "highshelf",
  "peaking",
  "notch",
  "allpass",
]);

function snapshot_effect(effect: AudioEffect): AudioEffect {
  const id = effect_id(effect.id);
  if (effect.type === "convolution") {
    if (
      typeof effect.impulse_clip !== "string" ||
      effect.impulse_clip.trim().length === 0
    ) {
      throw new Error(
        `audio effect ${JSON.stringify(id)} impulse clip ${
          JSON.stringify(effect.impulse_clip)
        } must be a non-empty string`,
      );
    }
    return Object.freeze({
      ...effect,
      id,
      impulse_clip: clip_id(effect.impulse_clip),
    });
  }
  return Object.freeze({ ...effect, id });
}

function copy_snapshot(snapshot: AudioGraphSnapshot): AudioGraphSnapshot {
  return Object.freeze({
    ...snapshot,
    buses: Object.freeze(snapshot.buses.map((bus) =>
      Object.freeze({
        ...bus,
        effects: Object.freeze(
          bus.effects.map((effect) => Object.freeze({ ...effect })),
        ),
        sends: Object.freeze(
          bus.sends.map((send) => Object.freeze({ ...send })),
        ),
      })
    )),
    processing_order: Object.freeze([...snapshot.processing_order]),
    levels: new Map(snapshot.levels),
  });
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
