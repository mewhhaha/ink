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
  const states = new Set<string>();
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
    validate_node(source.asset, state.node, clips, source.parameters);
  }
  if (!states.has(source.initial)) {
    throw new Error(
      `animation graph ${source.asset} initial state ${source.initial} is missing`,
    );
  }
  for (const transition of source.transitions) {
    if (!states.has(transition.from) || !states.has(transition.to)) {
      throw new Error(
        `animation graph ${source.asset} transition ${transition.from}->${transition.to} references a missing state`,
      );
    }
    if (!Number.isFinite(transition.duration) || transition.duration < 0) {
      throw new Error(
        `animation graph ${source.asset} transition ${transition.from}->${transition.to} duration ${transition.duration} must be nonnegative`,
      );
    }
    for (const condition of transition.conditions) {
      if (!(condition.parameter in source.parameters)) {
        throw new Error(
          `animation graph ${source.asset} transition references missing parameter ${condition.parameter}`,
        );
      }
    }
  }
  return Object.freeze({
    ...source,
    states: Object.freeze([...source.states]),
    transitions: Object.freeze([...source.transitions]),
    parameters: Object.freeze({ ...source.parameters }),
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
    this.#graph = create_graph(options.graph, options.clips);
    this.#skeleton = options.skeleton;
    this.#clips = options.clips;
    this.#observer = options.observer;
    this.#state = options.graph.initial;
    this.#parameters = { ...options.graph.parameters };
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
    this.#parameters[name] = value;
  }

  step(seconds: number): GraphOutput {
    if (!Number.isFinite(seconds) || seconds === 0) {
      throw new Error(
        `animation graph ${this.#graph.asset} step ${seconds} must be finite and nonzero`,
      );
    }
    const transition = this.#select_transition();
    if (transition !== undefined) this.#begin_transition(transition);
    let output: GraphOutput;
    if (this.#transition === null) {
      const previous = this.#state_time;
      this.#state_time += seconds;
      const evaluated = this.#evaluate_state(
        this.#state,
        previous,
        this.#state_time,
      );
      output = freeze_output(evaluated, this.#state, null);
    } else {
      const active = this.#transition;
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
    if (
      snapshot.format !== "ink.animation.graph" || snapshot.version !== 1 ||
      snapshot.asset !== this.#graph.asset ||
      !this.#graph.states.some(({ id }) => id === snapshot.state)
    ) {
      throw new Error(
        `animation graph snapshot ${snapshot.asset} is incompatible with ${this.#graph.asset}`,
      );
    }
    this.#state = snapshot.state;
    this.#state_time = snapshot.state_time;
    this.#parameters = { ...snapshot.parameters };
    this.#transition = snapshot.transition;
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
    this.#graph = parsed;
    this.#clips = clips;
    this.#parameters = { ...graph.parameters, ...this.#parameters };
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
  #begin_transition(source: GraphTransition): void {
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
    this.#transition = Object.freeze({
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
function validate_node(
  asset: AssetId<"animation.graph">,
  node: BlendNode,
  clips: ReadonlyMap<AssetId<"animation">, AnimationClip>,
  parameters: Readonly<Record<string, AnimationParameter>>,
): void {
  if (node.type === "clip") {
    if (!clips.has(node.clip)) {
      throw new Error(
        `animation graph ${asset} references missing clip ${node.clip}`,
      );
    }
    return;
  }
  if (node.type === "blend") {
    if (
      typeof parameters[node.parameter] !== "number" ||
      node.minimum >= node.maximum
    ) {
      throw new Error(
        `animation graph ${asset} blend parameter ${node.parameter} or range is invalid`,
      );
    }
    validate_node(asset, node.first, clips, parameters);
    validate_node(asset, node.second, clips, parameters);
    return;
  }
  if (typeof parameters[node.weight_parameter] !== "number") {
    throw new Error(
      `animation graph ${asset} additive weight ${node.weight_parameter} is missing`,
    );
  }
  validate_node(asset, node.base, clips, parameters);
  validate_node(asset, node.layer, clips, parameters);
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
