import {
  Do,
  get,
  put,
  run_state_terminal,
  type StateValue,
} from "@mewhhaha/typeclasses";
import { canonical_json, digest_text } from "./digest.ts";
import type { GameGuest } from "./guest.ts";
import type {
  GameAction,
  GameObservation,
  GameReplay,
  GameSave,
  GameTraceEvent,
  GameViewport,
  RenderSnapshot,
  ReplayStep,
} from "./protocol.ts";
import {
  create_game_save,
  parse_game_save,
  serialize_game_save,
} from "./save.ts";

interface SessionState {
  readonly guest_state: bigint;
  readonly random_state: bigint;
  readonly sequence: number;
  readonly initial_save: GameSave;
  readonly replay_steps: readonly ReplayStep[];
}

export interface SessionContext {
  readonly game_id: string;
  readonly artifact_digest: string;
  readonly schema_digest: string;
}

export interface HeadlessSession {
  describe(): GameObservation;
  render(): RenderSnapshot;
  set_viewport(viewport: GameViewport): GameObservation;
  trace(): readonly GameTraceEvent[];
  reload(
    guest: GameGuest,
    context: SessionContext,
  ): Promise<{
    readonly observation: GameObservation;
    readonly preserved: boolean;
  }>;
  step(action: GameAction, delta_us?: number): Promise<GameObservation>;
  reset(): Promise<GameObservation>;
  save(): Promise<string>;
  load(source: string): Promise<GameObservation>;
  finish_replay(): GameReplay;
  replay(replay: GameReplay): Promise<GameObservation>;
  close(): void;
}

export async function create_headless_session(
  guest: GameGuest,
  context: SessionContext,
  viewport: GameViewport = { width: 960, height: 540 },
): Promise<HeadlessSession> {
  let active_guest = guest;
  let active_context = context;
  const initial_guest_state = active_guest.start();
  const initial_save = await create_game_save(
    initial_guest_state,
    0n,
    active_context,
  );
  let current: SessionState = {
    guest_state: initial_guest_state,
    random_state: 0n,
    sequence: 0,
    initial_save,
    replay_steps: [],
  };
  let closed = false;
  let current_viewport = viewport;
  const trace_events: GameTraceEvent[] = [{ type: "initialized", sequence: 0 }];
  let operation_queue: Promise<void> = Promise.resolve();

  const require_open = () => {
    if (closed) throw new Error("headless game session is closed");
  };

  const describe = (): GameObservation => {
    require_open();
    return describe_with_state(
      active_guest,
      current.guest_state,
      current.sequence,
      current_viewport,
    );
  };

  const run_serialized = <result>(
    operation: () => Promise<result>,
  ): Promise<result> => {
    const pending = operation_queue.then(operation, operation);
    operation_queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  const step_now = async (
    action: GameAction,
    delta_us: number,
  ): Promise<GameObservation> => {
    require_open();
    const encoded = encode_action(action);
    const next_guest_state = active_guest.step(
      current.guest_state,
      encoded.kind,
      encoded.target,
      encoded.value,
      delta_us,
    );
    const next_sequence = current.sequence + 1;
    const next_observation = describe_with_state(
      active_guest,
      next_guest_state,
      next_sequence,
      current_viewport,
    );
    const replay_step: ReplayStep = {
      sequence: next_sequence,
      delta_us,
      action,
      state_digest: await digest_text(next_guest_state.toString()),
      observation_digest: await digest_text(canonical_json(next_observation)),
    };
    require_open();
    current = apply_session_transition(current, {
      type: "step",
      guest_state: next_guest_state,
      replay_step,
    });
    trace_events.push({
      type: "step",
      sequence: next_sequence,
      action,
      delta_us,
      outcome: next_observation.outcome,
    });
    return next_observation;
  };

  const load_now = async (source: string): Promise<GameObservation> => {
    require_open();
    const loaded = await parse_game_save(source, active_context);
    require_open();
    current = apply_session_transition(current, {
      type: "load",
      guest_state: loaded.state,
      random_state: loaded.random_state,
      loaded_save: loaded.save,
    });
    trace_events.push({ type: "loaded", sequence: 0 });
    return describe();
  };

  const session: HeadlessSession = {
    describe,
    render() {
      require_open();
      return render_with_state(
        active_guest,
        current.guest_state,
        current_viewport,
      );
    },
    set_viewport(next_viewport) {
      require_open();
      current_viewport = next_viewport;
      return describe();
    },
    trace() {
      require_open();
      return [...trace_events];
    },
    reload(next_guest, next_context) {
      return run_serialized(async () => {
        require_open();
        const preserved = active_context.game_id === next_context.game_id &&
          active_context.schema_digest === next_context.schema_digest;
        const guest_state = preserved
          ? current.guest_state
          : next_guest.start();
        const reload_save = await create_game_save(
          guest_state,
          current.random_state,
          next_context,
        );
        require_open();
        active_guest = next_guest;
        active_context = next_context;
        current = apply_session_transition(current, {
          type: "load",
          guest_state,
          random_state: current.random_state,
          loaded_save: reload_save,
        });
        trace_events.push({
          type: "reloaded",
          sequence: 0,
          preserved,
          artifact_digest: next_context.artifact_digest,
        });
        return { observation: describe(), preserved };
      });
    },
    step(action, delta_us = 16_667) {
      return run_serialized(() => step_now(action, delta_us));
    },
    reset() {
      return run_serialized(async () => {
        require_open();
        const guest_state = active_guest.start();
        const reset_save = await create_game_save(
          guest_state,
          0n,
          active_context,
        );
        require_open();
        current = apply_session_transition(current, {
          type: "reset",
          guest_state,
          reset_save,
        });
        trace_events.push({ type: "reset", sequence: 0 });
        return describe();
      });
    },
    save() {
      return run_serialized(async () => {
        require_open();
        const save = await create_game_save(
          current.guest_state,
          current.random_state,
          active_context,
        );
        require_open();
        trace_events.push({
          type: "saved",
          sequence: current.sequence,
          checksum: save.checksum,
        });
        return serialize_game_save(save);
      });
    },
    load(source) {
      return run_serialized(() => load_now(source));
    },
    finish_replay() {
      require_open();
      return {
        format: "ink-replay",
        version: 1,
        artifact_digest: active_context.artifact_digest,
        initial_save: current.initial_save,
        steps: current.replay_steps,
      };
    },
    replay(replay) {
      return run_serialized(async () => {
        require_open();
        if (replay.format !== "ink-replay" || replay.version !== 1) {
          throw new Error("replay must use ink-replay version 1");
        }
        if (replay.artifact_digest !== active_context.artifact_digest) {
          throw new Error(
            `replay artifact digest ${
              JSON.stringify(replay.artifact_digest)
            } does not match the loaded game`,
          );
        }

        const previous = current;
        const previous_trace_length = trace_events.length;
        try {
          await load_now(serialize_game_save(replay.initial_save));
          for (const expected of replay.steps) {
            const actual = await step_now(expected.action, expected.delta_us);
            const state_digest = current.replay_steps.at(-1)?.state_digest;
            const observation_digest = await digest_text(
              canonical_json(actual),
            );
            if (
              state_digest !== expected.state_digest ||
              observation_digest !== expected.observation_digest
            ) {
              throw new Error(
                `replay diverged at sequence ${expected.sequence}`,
              );
            }
          }
          return describe();
        } catch (error) {
          current = previous;
          trace_events.splice(previous_trace_length);
          throw error;
        }
      });
    },
    close() {
      closed = true;
    },
  };
  return session;
}

type SessionAction =
  | {
    readonly type: "step";
    readonly guest_state: bigint;
    readonly replay_step: ReplayStep;
  }
  | {
    readonly type: "reset";
    readonly guest_state: bigint;
    readonly reset_save: GameSave;
  }
  | {
    readonly type: "load";
    readonly guest_state: bigint;
    readonly random_state: bigint;
    readonly loaded_save: GameSave;
  };

function session_transition(
  action: SessionAction,
): StateValue<SessionState, void> {
  return Do(function* () {
    const previous = yield* get<SessionState>();
    switch (action.type) {
      case "step":
        return yield* put<SessionState>({
          ...previous,
          guest_state: action.guest_state,
          sequence: action.replay_step.sequence,
          replay_steps: [...previous.replay_steps, action.replay_step],
        });
      case "reset":
        return yield* put<SessionState>({
          guest_state: action.guest_state,
          random_state: 0n,
          sequence: 0,
          initial_save: action.reset_save,
          replay_steps: [],
        });
      case "load":
        return yield* put<SessionState>({
          guest_state: action.guest_state,
          random_state: action.random_state,
          sequence: 0,
          initial_save: action.loaded_save,
          replay_steps: [],
        });
    }
  });
}

function apply_session_transition(
  current: SessionState,
  action: SessionAction,
): SessionState {
  return run_state_terminal(session_transition(action), current)[1];
}

function encode_action(
  action: GameAction,
): { readonly kind: number; readonly target: number; readonly value: number } {
  switch (action.type) {
    case "frame":
      return { kind: 0, target: 0, value: 0 };
    case "focus":
      return { kind: 1, target: action.target, value: 0 };
    case "activate":
      return { kind: 2, target: action.target, value: 0 };
    case "custom":
      return {
        kind: action.kind,
        target: action.target,
        value: action.value,
      };
  }
}

function describe_with_state(
  guest: GameGuest,
  guest_state: bigint,
  sequence: number,
  viewport: GameViewport,
): GameObservation {
  const captured = guest.describe(guest_state, viewport);
  const region_ids = new Set<string>();
  for (const region of captured.regions) {
    if (region_ids.has(region.id)) {
      throw new Error(
        `game emitted duplicate semantic region id ${
          JSON.stringify(region.id)
        }`,
      );
    }
    region_ids.add(region.id);
  }
  const rendered = render_with_state(guest, guest_state, viewport);
  const object_ids = new Set(rendered.objects.map((object) => object.id));
  for (const region of captured.regions) {
    if (!object_ids.has(region.placement.object)) {
      throw new Error(
        `semantic region ${
          JSON.stringify(region.id)
        } attaches to missing scene object ${region.placement.object}`,
      );
    }
  }
  return {
    sequence,
    outcome: captured.status.done ? "won" : "running",
    projection: rendered.projection,
    regions: captured.regions,
    status: captured.status,
    actions: [
      ...captured.regions.flatMap((region) => region.actions),
      ...captured.actions,
    ],
  };
}

function render_with_state(
  guest: GameGuest,
  guest_state: bigint,
  viewport: GameViewport,
): RenderSnapshot {
  const rendered = guest.render(guest_state, viewport);
  const object_ids = new Set<number>();
  for (const object of rendered.objects) {
    if (object_ids.has(object.id)) {
      throw new Error(`game emitted duplicate scene object id ${object.id}`);
    }
    object_ids.add(object.id);
  }
  return rendered;
}
