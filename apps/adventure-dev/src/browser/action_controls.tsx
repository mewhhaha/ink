import { Button } from "@comp0/react";
import type { GameAction, GameObservation } from "@ink/blot/protocol.ts";

export interface GameActionControlsProps {
  readonly observation: GameObservation | undefined;
  readonly can_interact: boolean;
  readonly dispatch_game_action: (action: GameAction) => Promise<void>;
  readonly hidden_action_ids?: readonly string[];
}

export function GameActionControls({
  observation,
  can_interact,
  dispatch_game_action,
  hidden_action_ids = [],
}: GameActionControlsProps) {
  if (observation === undefined) {
    return null;
  }
  const actions = observation.actions.filter(({ id, action }) =>
    action.type !== "focus" && !hidden_action_ids.includes(id)
  );
  if (actions.length === 0) return null;
  return (
    <aside className="game-action-controls" aria-label="Adventure actions">
      <header>
        <p>{observation.status.label}</p>
        <output aria-live="polite">{observation.status.value}</output>
      </header>
      <div>
        {actions.map(({ id, label, action }) => (
          <Button
            key={id}
            type="button"
            disabled={!can_interact}
            onClick={() => void dispatch_game_action(action)}
          >
            {action_label(observation, label, action)}
          </Button>
        ))}
      </div>
      {!can_interact && <p>Press Play to enable these actions.</p>}
    </aside>
  );
}

function action_label(
  observation: GameObservation,
  fallback: string,
  action: GameAction,
): string {
  if (action.type !== "activate") return fallback;
  const region = observation.regions.find((candidate) =>
    candidate.role === "button" && candidate.target === action.target
  );
  return region?.label ?? fallback;
}
