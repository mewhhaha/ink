import {
  Do,
  get,
  put,
  run_state_terminal,
  type StateValue,
} from "@mewhhaha/typeclasses";
import type { BlotGuest } from "./blot_guest.ts";
import { canonical_json, digest_text } from "./digest.ts";
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
  readonly artifact_digest: string;
  readonly schema_digest: string;
}

export interface HeadlessSession {
  observe(): GameObservation;
  render(): RenderSnapshot;
  set_viewport(viewport: GameViewport): GameObservation;
  trace(): readonly GameTraceEvent[];
  reload(
    guest: BlotGuest,
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
  guest: BlotGuest,
  context: SessionContext,
  viewport: GameViewport = { width: 960, height: 540 },
): Promise<HeadlessSession> {
  let active_guest = guest;
  let active_context = context;
  const initial_guest_state = active_guest.init(-1n);
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

  const observe = (): GameObservation => {
    require_open();
    const captured = active_guest.observe(
      current.guest_state,
      current_viewport,
    );
    const rendered = active_guest.render(current.guest_state, current_viewport);
    return {
      sequence: current.sequence,
      outcome: captured.status.done ? "won" : "running",
      projection: rendered.projection,
      regions: captured.regions,
      status: captured.status,
      actions: [
        ...captured.regions.flatMap((region) => region.actions),
        {
          id: "toggle_projection",
          label: "Toggle projection",
          action: { type: "toggle_projection" as const },
        },
      ],
    };
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
    const next_observation = observe_with_state(
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
    const restored = active_guest.init(loaded.state);
    current = apply_session_transition(current, {
      type: "load",
      guest_state: restored,
      random_state: loaded.random_state,
      loaded_save: loaded.save,
    });
    trace_events.push({ type: "loaded", sequence: 0 });
    return observe();
  };

  const session: HeadlessSession = {
    observe,
    render() {
      require_open();
      return active_guest.render(current.guest_state, current_viewport);
    },
    set_viewport(next_viewport) {
      require_open();
      current_viewport = next_viewport;
      return observe();
    },
    trace() {
      require_open();
      return [...trace_events];
    },
    reload(next_guest, next_context) {
      return run_serialized(async () => {
        require_open();
        const preserved = active_context.schema_digest ===
          next_context.schema_digest;
        const guest_state = next_guest.init(
          preserved ? current.guest_state : -1n,
        );
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
        return { observation: observe(), preserved };
      });
    },
    step(action, delta_us = 16_667) {
      return run_serialized(() => step_now(action, delta_us));
    },
    reset() {
      return run_serialized(async () => {
        require_open();
        const guest_state = active_guest.init(-1n);
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
        return observe();
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
          return observe();
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
    case "focus":
      return { kind: 1, target: action.target, value: 0 };
    case "activate":
      return { kind: 2, target: action.target, value: 0 };
    case "toggle_projection":
      return { kind: 3, target: 0, value: 0 };
  }
}

function observe_with_state(
  guest: BlotGuest,
  guest_state: bigint,
  sequence: number,
  viewport: GameViewport,
): GameObservation {
  const captured = guest.observe(guest_state, viewport);
  const rendered = guest.render(guest_state, viewport);
  return {
    sequence,
    outcome: captured.status.done ? "won" : "running",
    projection: rendered.projection,
    regions: captured.regions,
    status: captured.status,
    actions: [
      ...captured.regions.flatMap((region) => region.actions),
      {
        id: "toggle_projection",
        label: "Toggle projection",
        action: { type: "toggle_projection" },
      },
    ],
  };
}
