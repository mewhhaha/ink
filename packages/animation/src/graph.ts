import type { AssetId } from "@ink/assets/identity.ts";
import type { Observer } from "@ink/observability/observer.ts";
import { vec3_add, vec3_scale } from "@ink/math/vector.ts";
import {
  additive_pose,
  bind_pose,
  blend_poses,
  type JointMask,
  type Pose,
} from "./pose.ts";
import type {
  AnimationClip,
  ClipSample,
  RootMotionDelta,
  TraversedEvent,
} from "./clip.ts";
import { root_motion_delta, sample_clip, traverse_events } from "./clip.ts";
import type { Skeleton } from "./skeleton.ts";

export type AnimationParameter = number | boolean;
export type BlendNode =
  | {
    readonly type: "clip";
    readonly clip: AssetId<"animation">;
    readonly speed?: number;
  }
  | {
    readonly type: "blend";
    readonly parameter: string;
    readonly minimum: number;
    readonly maximum: number;
    readonly first: BlendNode;
    readonly second: BlendNode;
  }
  | {
    readonly type: "additive";
    readonly base: BlendNode;
    readonly layer: BlendNode;
    readonly weight_parameter: string;
    readonly mask?: JointMask;
  };
export interface GraphState {
  readonly id: string;
  readonly node: BlendNode;
}
export type TransitionCondition = {
  readonly parameter: string;
  readonly operator: "greater" | "less" | "equal" | "not_equal";
  readonly value: AnimationParameter;
};
export interface GraphTransition {
  readonly from: string;
  readonly to: string;
  readonly duration: number;
  readonly conditions: readonly TransitionCondition[];
  readonly priority?: number;
  readonly synchronize?: boolean;
}
export interface AnimationGraph {
  readonly asset: AssetId<"animation.graph">;
  readonly initial: string;
  readonly states: readonly GraphState[];
  readonly transitions: readonly GraphTransition[];
  readonly parameters: Readonly<Record<string, AnimationParameter>>;
}
export interface GraphOutput {
  readonly pose: Pose;
  readonly morph_weights: ReadonlyMap<string, number>;
  readonly properties: ReadonlyMap<string, number>;
  readonly root_motion: RootMotionDelta;
  readonly events: readonly TraversedEvent[];
  readonly state: string;
  readonly transition: {
    readonly from: string;
    readonly to: string;
    readonly weight: number;
  } | null;
}
export interface GraphSnapshot {
  readonly format: "ink.animation.graph";
  readonly version: 1;
  readonly asset: AssetId<"animation.graph">;
  readonly state: string;
  readonly state_time: number;
  readonly parameters: Readonly<Record<string, AnimationParameter>>;
  readonly transition: RuntimeTransition | null;
}
interface RuntimeTransition {
  readonly from: string;
  readonly to: string;
  readonly duration: number;
  readonly from_time: number;
  readonly to_time: number;
  readonly elapsed: number;
  readonly synchronize: boolean;
}
interface EvaluatedNode extends ClipSample {
  readonly events: readonly TraversedEvent[];
  readonly root_motion: RootMotionDelta;
}

export function create_graph(
  source: AnimationGraph,
  clips: ReadonlyMap<AssetId<"animation">, AnimationClip>,
): AnimationGraph {
  const parameters = parse_parameters(source.asset, source.parameters);
  const states = new Set<string>();
  const parsed_states: GraphState[] = [];
  for (const state of source.states) {
    const id = state.id.trim();
    if (id.length === 0 || states.has(id)) {
      throw new Error(
        `animation graph ${source.asset} has invalid or repeated state ${
          JSON.stringify(state.id)
        }`,
      );
    }
    states.add(id);
    parsed_states.push(Object.freeze({
      id,
      node: parse_node(source.asset, state.node, clips, parameters),
    }));
  }
  const initial = source.initial.trim();
  if (!states.has(initial)) {
    throw new Error(
      `animation graph ${source.asset} initial state ${source.initial} is missing`,
    );
  }
  const transitions = source.transitions.map((transition) =>
    parse_transition(source.asset, transition, states, parameters)
  );
  return Object.freeze({
    asset: source.asset,
    initial,
    states: Object.freeze(parsed_states),
    transitions: Object.freeze(transitions),
    parameters,
  });
}

export class AnimationGraphInstance {
  #graph: AnimationGraph;
  readonly #skeleton: Skeleton;
  #clips: ReadonlyMap<AssetId<"animation">, AnimationClip>;
  readonly #observer: Observer | undefined;
  #state: string;
  #state_time = 0;
  #parameters: Record<string, AnimationParameter>;
  #transition: RuntimeTransition | null = null;

  constructor(
    options: {
      readonly graph: AnimationGraph;
      readonly skeleton: Skeleton;
      readonly clips: ReadonlyMap<AssetId<"animation">, AnimationClip>;
      readonly observer?: Observer;
    },
  ) {
    const graph = create_graph(options.graph, options.clips);
    this.#graph = graph;
    this.#skeleton = options.skeleton;
    this.#clips = new Map(options.clips);
    this.#observer = options.observer;
    this.#state = graph.initial;
    this.#parameters = { ...graph.parameters };
  }

  set_parameter(name: string, value: AnimationParameter): void {
    const current = this.#parameters[name];
    if (current === undefined) {
      throw new Error(
        `animation graph ${this.#graph.asset} parameter ${name} is missing`,
      );
    }
    if (typeof current !== typeof value) {
      throw new Error(
        `animation graph ${this.#graph.asset} parameter ${name} expected ${typeof current}, received ${typeof value}`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(
        `animation graph ${this.#graph.asset} parameter ${name} must be finite`,
      );
    }
    if (
      typeof value === "number" && (value < 0 || value > 1) &&
      this.#graph.states.some(({ node }) => uses_additive_weight(node, name))
    ) {
      throw new Error(
        `animation graph ${this.#graph.asset} additive parameter ${name} value ${value} must be in 0..1`,
      );
    }
    this.#parameters[name] = value;
  }

  step(seconds: number): GraphOutput {
    if (!Number.isFinite(seconds) || seconds === 0) {
      throw new Error(
        `animation graph ${this.#graph.asset} step ${seconds} must be finite and nonzero`,
      );
    }
    const selected_transition = this.#select_transition();
    const transition = selected_transition === undefined
      ? this.#transition
      : this.#create_transition(selected_transition);
    let output: GraphOutput;
    if (transition === null) {
      const previous = this.#state_time;
      const current = previous + seconds;
      if (!Number.isFinite(current)) {
        throw new Error(
          `animation graph ${this.#graph.asset} state time ${previous} + ${seconds} must be finite`,
        );
      }
      const evaluated = this.#evaluate_state(
        this.#state,
        previous,
        current,
      );
      output = freeze_output(evaluated, this.#state, null);
      this.#state_time = current;
    } else {
      const active = transition;
      const from_previous = active.from_time + active.elapsed;
      const to_previous = active.to_time + active.elapsed;
      const elapsed = active.elapsed + Math.abs(seconds);
      const weight = active.duration === 0
        ? 1
        : Math.min(1, elapsed / active.duration);
      const first = this.#evaluate_state(
        active.from,
        from_previous,
        from_previous + seconds,
      );
      const second = this.#evaluate_state(
        active.to,
        to_previous,
        to_previous + seconds,
      );
      const blended = blend_evaluations(first, second, weight);
      output = freeze_output(blended, active.to, {
        from: active.from,
        to: active.to,
        weight,
      });
      if (weight === 1) {
        this.#state = active.to;
        this.#state_time = to_previous + seconds;
        this.#transition = null;
      } else this.#transition = Object.freeze({ ...active, elapsed });
    }
    this.#observer?.event("animation.graph.evaluated", {
      graph: this.#graph.asset,
      state: output.state,
      joints: output.pose.transforms.length,
      events: output.events.length,
      transition_active: output.transition !== null,
    });
    return output;
  }

  snapshot(): GraphSnapshot {
    return Object.freeze({
      format: "ink.animation.graph",
      version: 1,
      asset: this.#graph.asset,
      state: this.#state,
      state_time: this.#state_time,
      parameters: Object.freeze({ ...this.#parameters }),
      transition: this.#transition,
    });
  }
  restore(snapshot: GraphSnapshot): void {
    const parsed = parse_snapshot(this.#graph, snapshot);
    this.#state = parsed.state;
    this.#state_time = parsed.state_time;
    this.#parameters = { ...parsed.parameters };
    this.#transition = parsed.transition;
  }
  replace(
    graph: AnimationGraph,
    clips: ReadonlyMap<AssetId<"animation">, AnimationClip>,
  ): void {
    const parsed = create_graph(graph, clips);
    if (!parsed.states.some(({ id }) => id === this.#state)) {
      throw new Error(
        `animation graph replacement ${graph.asset} lacks active state ${this.#state}`,
      );
    }
    const parameters: Record<string, AnimationParameter> = {};
    for (const [name, fallback] of Object.entries(parsed.parameters)) {
      const current = this.#parameters[name];
      parameters[name] = typeof current === typeof fallback
        ? current
        : fallback;
    }
    this.#graph = parsed;
    this.#clips = new Map(clips);
    this.#parameters = parameters;
    if (
      this.#transition !== null &&
      (!parsed.states.some(({ id }) => id === this.#transition!.from) ||
        !parsed.states.some(({ id }) => id === this.#transition!.to))
    ) this.#transition = null;
    this.#observer?.event("animation.graph.replaced", {
      graph: graph.asset,
      active_state: this.#state,
    });
  }

  #state_source(id: string): GraphState {
    return this.#graph.states.find((state) => state.id === id)!;
  }
  #evaluate_state(
    id: string,
    previous: number,
    current: number,
  ): EvaluatedNode {
    return evaluate_node(
      this.#skeleton,
      this.#state_source(id).node,
      this.#clips,
      this.#parameters,
      previous,
      current,
    );
  }
  #select_transition(): GraphTransition | undefined {
    const source = this.#transition?.to ?? this.#state;
    return this.#graph.transitions.filter(({ from }) => from === source).filter(
      ({ conditions }) =>
        conditions.every((condition) =>
          condition_matches(this.#parameters[condition.parameter], condition)
        ),
    ).sort((left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) ||
      left.to.localeCompare(right.to)
    )[0];
  }
  #create_transition(source: GraphTransition): RuntimeTransition {
    const from_time = this.#transition === null
      ? this.#state_time
      : this.#transition.to_time + this.#transition.elapsed;
    let to_time = 0;
    if (source.synchronize) {
      const from_clip = primary_clip(
        this.#state_source(source.from).node,
        this.#clips,
      );
      const to_clip = primary_clip(
        this.#state_source(source.to).node,
        this.#clips,
      );
      if (from_clip !== undefined && to_clip !== undefined) {
        to_time = (from_time / from_clip.duration % 1) * to_clip.duration;
      }
    }
    return Object.freeze({
      from: source.from,
      to: source.to,
      duration: source.duration,
      from_time,
      to_time,
      elapsed: 0,
      synchronize: source.synchronize ?? false,
    });
  }
}

function evaluate_node(
  skeleton: Skeleton,
  node: BlendNode,
  clips: ReadonlyMap<AssetId<"animation">, AnimationClip>,
  parameters: Readonly<Record<string, AnimationParameter>>,
  previous: number,
  current: number,
): EvaluatedNode {
  if (node.type === "clip") {
    const clip = clips.get(node.clip)!;
    const speed = node.speed ?? 1;
    const start = previous * speed;
    const finish = current * speed;
    return Object.freeze({
      ...sample_clip(skeleton, clip, finish),
      events: traverse_events(clip, start, finish),
      root_motion: root_motion_delta(skeleton, clip, start, finish),
    });
  }
  if (node.type === "blend") {
    const value = parameters[node.parameter] as number;
    const amount = Math.max(
      0,
      Math.min(1, (value - node.minimum) / (node.maximum - node.minimum)),
    );
    return blend_evaluations(
      evaluate_node(skeleton, node.first, clips, parameters, previous, current),
      evaluate_node(
        skeleton,
        node.second,
        clips,
        parameters,
        previous,
        current,
      ),
      amount,
    );
  }
  const base = evaluate_node(
    skeleton,
    node.base,
    clips,
    parameters,
    previous,
    current,
  );
  const layer = evaluate_node(
    skeleton,
    node.layer,
    clips,
    parameters,
    previous,
    current,
  );
  const weight = parameters[node.weight_parameter] as number;
  return Object.freeze({
    ...base,
    pose: additive_pose(
      base.pose,
      layer.pose,
      bind_pose(skeleton),
      weight,
      node.mask,
    ),
    events: Object.freeze(
      [...base.events, ...layer.events].sort((a, b) =>
        a.occurrence_time - b.occurrence_time
      ),
    ),
    morph_weights: blend_maps(base.morph_weights, layer.morph_weights, weight),
    root_motion: {
      translation: vec3_add(
        base.root_motion.translation,
        vec3_scale(layer.root_motion.translation, weight),
      ),
    },
  });
}
function blend_evaluations(
  first: EvaluatedNode,
  second: EvaluatedNode,
  weight: number,
): EvaluatedNode {
  return Object.freeze({
    pose: blend_poses(first.pose, second.pose, weight),
    properties: blend_maps(first.properties, second.properties, weight),
    morph_weights: blend_maps(
      first.morph_weights,
      second.morph_weights,
      weight,
    ),
    events: Object.freeze(
      [...first.events, ...second.events].sort((a, b) =>
        a.occurrence_time - b.occurrence_time || a.name.localeCompare(b.name)
      ),
    ),
    root_motion: {
      translation: vec3_add(
        vec3_scale(first.root_motion.translation, 1 - weight),
        vec3_scale(second.root_motion.translation, weight),
      ),
    },
  });
}
function blend_maps(
  first: ReadonlyMap<string, number>,
  second: ReadonlyMap<string, number>,
  weight: number,
): ReadonlyMap<string, number> {
  const keys = new Set([...first.keys(), ...second.keys()]);
  return new Map(
    [...keys].sort().map((
      key,
    ) => [
      key,
      (first.get(key) ?? 0) * (1 - weight) + (second.get(key) ?? 0) * weight,
    ]),
  );
}
function parse_node(
  asset: AssetId<"animation.graph">,
  node: BlendNode,
  clips: ReadonlyMap<AssetId<"animation">, AnimationClip>,
  parameters: Readonly<Record<string, AnimationParameter>>,
): BlendNode {
  if (node.type === "clip") {
    if (!clips.has(node.clip)) {
      throw new Error(
        `animation graph ${asset} references missing clip ${node.clip}`,
      );
    }
    const speed = node.speed ?? 1;
    if (!Number.isFinite(speed)) {
      throw new Error(
        `animation graph ${asset} clip ${node.clip} speed ${speed} must be finite`,
      );
    }
    return Object.freeze({
      type: "clip",
      clip: node.clip,
      ...(node.speed === undefined ? {} : { speed }),
    });
  }
  if (node.type === "blend") {
    const parameter = node.parameter.trim();
    if (
      typeof parameters[parameter] !== "number" ||
      !Number.isFinite(node.minimum) || !Number.isFinite(node.maximum) ||
      node.minimum >= node.maximum
    ) {
      throw new Error(
        `animation graph ${asset} blend parameter ${node.parameter} or range is invalid`,
      );
    }
    return Object.freeze({
      type: "blend",
      parameter,
      minimum: node.minimum,
      maximum: node.maximum,
      first: parse_node(asset, node.first, clips, parameters),
      second: parse_node(asset, node.second, clips, parameters),
    });
  }
  const weight_parameter = node.weight_parameter.trim();
  const default_weight = parameters[weight_parameter];
  if (typeof default_weight !== "number") {
    throw new Error(
      `animation graph ${asset} additive weight ${node.weight_parameter} is missing`,
    );
  }
  if (default_weight < 0 || default_weight > 1) {
    throw new Error(
      `animation graph ${asset} additive weight ${weight_parameter} value ${default_weight} must be in 0..1`,
    );
  }
  const mask = node.mask === undefined
    ? undefined
    : Object.freeze({ weights: Object.freeze([...node.mask.weights]) });
  if (
    mask?.weights.some((weight) =>
      !Number.isFinite(weight) || weight < 0 || weight > 1
    )
  ) {
    throw new Error(`animation graph ${asset} additive mask is invalid`);
  }
  return Object.freeze({
    type: "additive",
    base: parse_node(asset, node.base, clips, parameters),
    layer: parse_node(asset, node.layer, clips, parameters),
    weight_parameter,
    ...(mask === undefined ? {} : { mask }),
  });
}

function parse_parameters(
  asset: AssetId<"animation.graph">,
  source: Readonly<Record<string, AnimationParameter>>,
): Readonly<Record<string, AnimationParameter>> {
  const names = new Set<string>();
  const entries: [string, AnimationParameter][] = [];
  for (const [source_name, value] of Object.entries(source)) {
    const name = source_name.trim();
    if (name.length === 0 || names.has(name)) {
      throw new Error(
        `animation graph ${asset} has invalid or repeated parameter ${
          JSON.stringify(source_name)
        }`,
      );
    }
    if (
      typeof value !== "boolean" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(
        `animation graph ${asset} parameter ${name} value ${
          String(value)
        } must be finite or boolean`,
      );
    }
    names.add(name);
    entries.push([name, value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function parse_transition(
  asset: AssetId<"animation.graph">,
  source: GraphTransition,
  states: ReadonlySet<string>,
  parameters: Readonly<Record<string, AnimationParameter>>,
): GraphTransition {
  const from = source.from.trim();
  const to = source.to.trim();
  if (!states.has(from) || !states.has(to)) {
    throw new Error(
      `animation graph ${asset} transition ${source.from}->${source.to} references a missing state`,
    );
  }
  if (!Number.isFinite(source.duration) || source.duration < 0) {
    throw new Error(
      `animation graph ${asset} transition ${from}->${to} duration ${source.duration} must be nonnegative`,
    );
  }
  if (source.priority !== undefined && !Number.isFinite(source.priority)) {
    throw new Error(
      `animation graph ${asset} transition ${from}->${to} priority ${source.priority} must be finite`,
    );
  }
  if (
    source.synchronize !== undefined &&
    typeof source.synchronize !== "boolean"
  ) {
    throw new Error(
      `animation graph ${asset} transition ${from}->${to} synchronize ${
        JSON.stringify(source.synchronize)
      } must be boolean`,
    );
  }
  const conditions = source.conditions.map((condition) => {
    const parameter = condition.parameter.trim();
    const expected = parameters[parameter];
    if (expected === undefined) {
      throw new Error(
        `animation graph ${asset} transition references missing parameter ${condition.parameter}`,
      );
    }
    if (
      condition.operator !== "greater" && condition.operator !== "less" &&
      condition.operator !== "equal" && condition.operator !== "not_equal"
    ) {
      throw new Error(
        `animation graph ${asset} transition ${from}->${to} operator ${
          JSON.stringify(condition.operator)
        } is invalid`,
      );
    }
    if (
      typeof condition.value !== typeof expected ||
      (typeof condition.value === "number" &&
        !Number.isFinite(condition.value)) ||
      ((condition.operator === "greater" || condition.operator === "less") &&
        typeof expected !== "number")
    ) {
      throw new Error(
        `animation graph ${asset} transition ${from}->${to} condition ${parameter} is incompatible with its parameter`,
      );
    }
    return Object.freeze({ ...condition, parameter });
  });
  return Object.freeze({
    from,
    to,
    duration: source.duration,
    conditions: Object.freeze(conditions),
    ...(source.priority === undefined ? {} : { priority: source.priority }),
    ...(source.synchronize === undefined
      ? {}
      : { synchronize: source.synchronize }),
  });
}

function parse_snapshot(
  graph: AnimationGraph,
  source: GraphSnapshot,
): GraphSnapshot {
  const compatible = source.format === "ink.animation.graph" &&
    source.version === 1 && source.asset === graph.asset &&
    graph.states.some(({ id }) => id === source.state);
  if (!compatible) {
    throw new Error(
      `animation graph snapshot ${source.asset} is incompatible with ${graph.asset}`,
    );
  }
  if (!Number.isFinite(source.state_time)) {
    throw new Error(
      `animation graph snapshot ${source.asset} state time ${source.state_time} must be finite`,
    );
  }
  const parameters = parse_parameters(graph.asset, source.parameters);
  const expected_names = Object.keys(graph.parameters).sort();
  const received_names = Object.keys(parameters).sort();
  if (
    expected_names.length !== received_names.length ||
    expected_names.some((name, index) =>
      name !== received_names[index] ||
      typeof graph.parameters[name] !== typeof parameters[name]
    )
  ) {
    throw new Error(
      `animation graph snapshot ${source.asset} parameters ${
        received_names.join(",")
      } do not match ${expected_names.join(",")}`,
    );
  }
  const transition = source.transition === null
    ? null
    : parse_runtime_transition(graph, source.state, source.transition);
  return Object.freeze({
    format: "ink.animation.graph",
    version: 1,
    asset: graph.asset,
    state: source.state,
    state_time: source.state_time,
    parameters,
    transition,
  });
}

function parse_runtime_transition(
  graph: AnimationGraph,
  state: string,
  source: RuntimeTransition,
): RuntimeTransition {
  const states = new Set(graph.states.map(({ id }) => id));
  if (
    source.from !== state || !states.has(source.from) ||
    !states.has(source.to) || !Number.isFinite(source.duration) ||
    source.duration < 0 || !Number.isFinite(source.from_time) ||
    !Number.isFinite(source.to_time) || !Number.isFinite(source.elapsed) ||
    source.elapsed < 0 || source.elapsed > source.duration ||
    typeof source.synchronize !== "boolean"
  ) {
    throw new Error(
      `animation graph snapshot ${graph.asset} transition ${source.from}->${source.to} is invalid`,
    );
  }
  return Object.freeze({
    from: source.from,
    to: source.to,
    duration: source.duration,
    from_time: source.from_time,
    to_time: source.to_time,
    elapsed: source.elapsed,
    synchronize: source.synchronize,
  });
}
function condition_matches(
  value: AnimationParameter,
  condition: TransitionCondition,
): boolean {
  switch (condition.operator) {
    case "greater":
      return typeof value === "number" && typeof condition.value === "number" &&
        value > condition.value;
    case "less":
      return typeof value === "number" && typeof condition.value === "number" &&
        value < condition.value;
    case "equal":
      return value === condition.value;
    case "not_equal":
      return value !== condition.value;
  }
}
function uses_additive_weight(node: BlendNode, parameter: string): boolean {
  if (node.type === "clip") return false;
  if (node.type === "blend") {
    return uses_additive_weight(node.first, parameter) ||
      uses_additive_weight(node.second, parameter);
  }
  return node.weight_parameter === parameter ||
    uses_additive_weight(node.base, parameter) ||
    uses_additive_weight(node.layer, parameter);
}
function primary_clip(
  node: BlendNode,
  clips: ReadonlyMap<AssetId<"animation">, AnimationClip>,
): AnimationClip | undefined {
  return node.type === "clip"
    ? clips.get(node.clip)
    : primary_clip(node.type === "blend" ? node.first : node.base, clips);
}
function freeze_output(
  evaluated: EvaluatedNode,
  state: string,
  transition: GraphOutput["transition"],
): GraphOutput {
  return Object.freeze({
    ...evaluated,
    state,
    transition: transition === null ? null : Object.freeze(transition),
  });
}
