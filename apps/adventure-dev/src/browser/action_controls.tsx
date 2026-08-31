import { Button } from "@comp0/react";
import type { GameAction, GameObservation } from "@ink/blot/protocol.ts";
import type { LocalizationResolver } from "@ink/ui/localization.ts";
import { require_ui_text } from "@ink/ui/localization.ts";

const literal_resolver: LocalizationResolver = {
  resolve(id) {
    throw new Error(
      `adventure UI unexpectedly requested localization message ${
        JSON.stringify(id)
      }`,
    );
  },
};

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
  const actions = observation.actions.filter(({ id, trigger }) =>
    trigger.type === "command" && !hidden_action_ids.includes(id)
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
            {require_ui_text(label, literal_resolver)}
          </Button>
        ))}
      </div>
      {!can_interact && <p>Press Play to enable these actions.</p>}
    </aside>
  );
}
