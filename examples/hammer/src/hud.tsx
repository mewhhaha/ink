/** The game's HUD: plain React over the world's `game` resource. */
import { useEffect, useState } from "react";
import { useMode, useResource, useSessionValue } from "@ink/react";

interface Game {
  finished: boolean;
  focus: number;
  presses: number;
}

export function Hud() {
  const { mode, paused } = useMode();
  const game = useResource("game") as Game | undefined;
  const focusName = useSessionValue((
    s,
  ) => (game?.focus ? s.nameOf(game.focus) : ""));
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const update = () => setLocked(document.pointerLockElement !== null);
    document.addEventListener("pointerlockchange", update);
    return () => document.removeEventListener("pointerlockchange", update);
  }, []);
  if (mode !== "play" || !game) return null;
  return (
    <div className="hammer-hud">
      <div className="hammer-crosshair" data-active={game.focus !== 0} />
      {game.focus !== 0 && !paused && (
        <div className="hammer-prompt">
          <kbd>E</kbd> Press {focusName}
        </div>
      )}
      {!locked && !game.finished && (
        <div className="hammer-hint">
          Click to look around · WASD move · Space jump · E use · arrows turn ·
          Esc frees the mouse
        </div>
      )}
      {game.finished && (
        <div className="hammer-complete">
          <div className="hammer-complete-title">Level complete</div>
          <div>{game.presses} button press{game.presses === 1 ? "" : "es"}</div>
          <div className="hammer-complete-sub">
            Stop (F5) to return to the editor
          </div>
        </div>
      )}
    </div>
  );
}
