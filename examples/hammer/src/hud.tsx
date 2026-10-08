/** The game's HUD: plain React over the world's `game` resource. */
import { useEffect, useState } from "react";
import {
  createSchemaHooks,
  useMessages,
  useMode,
  useSessionValue,
} from "@ink/react";
import type { Message, World } from "../game/schema.gen.ts";
const { useResource } = createSchemaHooks<World>();

export function Hud() {
  const { mode, paused } = useMode();
  const game = useResource("game");
  const { text } = useMessages<Message>();
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
          <kbd>E</kbd> {text("press_hud", focusName)}
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
          <div className="hammer-complete-title">{text("level_finished")}</div>
          <div>{text("presses_hud", game.presses)}</div>
          <div className="hammer-complete-sub">
            {text("stop_hud")}
          </div>
        </div>
      )}
    </div>
  );
}
