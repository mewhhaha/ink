import { useEffect, useState } from "react";
import {
  MultiplayerPlay,
  type NetworkMode,
  type NetworkStatus,
  type Session,
} from "@ink/core";
import { useInk, useSessionValue } from "./context.tsx";
const connections = new WeakMap<Session, MultiplayerPlay>();

/** Opt-in room controls: the editor supplies a scene with player-owned entities. */
export function MultiplayerControls({ scene }: { scene: string }) {
  const ink = useInk();
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState("feel-lab");
  const [mode, setMode] = useState<NetworkMode>("rollback");
  const [delayMs, setDelay] = useState(100);
  const [current, setCurrent] = useState(() => connections.get(ink.session));
  const [status, setStatus] = useState<NetworkStatus | null>(
    current?.status ?? null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canStep = useSessionValue((s) =>
    s.canStep && s.status.kind === "ready"
  );
  useEffect(() => {
    if (!current) return;
    let previousPhase = "waiting";
    const update = () => {
      const status = current.status;
      setStatus({ ...status });
      if (status.phase === "playing" && previousPhase !== "playing") {
        setOpen(false);
      }
      previousPhase = status.phase;
      if (status.phase === "closed") setError(status.reason ?? "Disconnected");
    };
    update();
    return current.subscribe(update);
  }, [current]);
  const connected = status && status.phase !== "closed";
  const join = async () => {
    if (!ink.dev || busy) return;
    setBusy(true);
    setError("");
    try {
      if (ink.session.sceneName !== scene) await ink.dev.openScene(scene);
      const session = ink.session;
      const identity = `${scene}:${session.schema.hash}:${
        session.status.kind === "ready" ? session.status.revision : -1
      }:${JSON.stringify(session.catalog)}`;
      const channel = ink.dev.client.multiplayer((message) =>
        play.receive(message)
      );
      const play = new MultiplayerPlay(session, channel, {
        room,
        identity,
        mode,
        delayMs,
        clock: "realtime",
      });
      connections.set(session, play);
      setCurrent(play);
      play.join();
    } catch (e) {
      connections.get(ink.session)?.close();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="ink-button"
        type="button"
        onClick={() => setOpen(true)}
      >
        {connected
          ? `Player ${(status.peer ?? 0) + 1} · ${
            status.phase === "waiting" ? "Waiting" : "Online"
          }`
          : "Multiplayer"}
      </button>
      {status?.phase === "playing" && (
        <output
          aria-label="Multiplayer status"
          style={{
            fontSize: 11,
            color: "var(--ink-muted)",
            whiteSpace: "nowrap",
          }}
          title={`Tick ${status.tick} · confirmed ${status.confirmed} · ${status.replayedTicks} replayed steps`}
        >
          {status.delayMs} ms · {status.predicted} predicted ·{" "}
          {status.rollbacks} rollbacks
        </output>
      )}
      {error && !open && (
        <button
          className="ink-button"
          type="button"
          onClick={() => setOpen(true)}
          title={error}
        >
          Room closed
        </button>
      )}
      {open && (
        <div
          className="ink-overlay"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <section
            className="ink-palette"
            role="dialog"
            aria-label="Multiplayer"
            style={{ width: 430 }}
          >
            <header className="ink-panel-header">
              <b>Play together</b>
              <span className="ink-bar-spacer" />
              <button
                className="ink-button"
                type="button"
                onClick={() =>
                  setOpen(false)}
              >
                Close
              </button>
            </header>
            <div style={{ padding: 18, display: "grid", gap: 14 }}>
              <p style={{ margin: 0, color: "var(--ink-muted)" }}>
                Open this editor in two browsers and join the same room. Player
                1 is blue; player 2 is orange. A/D to run, Space to jump.
              </p>
              <label>
                Room{" "}
                <input
                  className="ink-input"
                  aria-label="Room"
                  value={room}
                  disabled={!!connected || busy}
                  maxLength={48}
                  onChange={(e) => setRoom(e.target.value)}
                />
              </label>
              <label>
                Simulation{" "}
                <select
                  aria-label="Simulation"
                  disabled={!!connected || busy}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as NetworkMode)}
                >
                  <option value="rollback">
                    Rollback — immediate local controls
                  </option>
                  <option value="lockstep">
                    Lockstep — wait for both inputs
                  </option>
                </select>
              </label>
              <label>
                Simulated input delay{" "}
                <select
                  aria-label="Input delay"
                  disabled={!!connected || busy}
                  value={delayMs}
                  onChange={(e) => setDelay(Number(e.target.value))}
                >
                  <option value={0}>Off</option>
                  <option value={50}>50 ms each way</option>
                  <option value={100}>100 ms each way</option>
                  <option value={150}>150 ms each way</option>
                </select>
              </label>
              {connected && (
                <p role="status" style={{ margin: 0 }}>
                  {status.phase === "waiting"
                    ? "Waiting for the other player…"
                    : `Playing as player ${status.peer! + 1}`}
                </p>
              )}
              {error && (
                <p
                  role="alert"
                  style={{ color: "var(--ink-danger)", margin: 0 }}
                >
                  {error}
                </p>
              )}
              {connected
                ? (
                  <button
                    className="ink-button"
                    type="button"
                    onClick={() => current?.close()}
                  >
                    Leave room
                  </button>
                )
                : (
                  <button
                    className="ink-button"
                    type="button"
                    disabled={!canStep || busy ||
                      !/^[a-zA-Z0-9_-]{1,48}$/.test(room)}
                    onClick={() => void join()}
                  >
                    {busy ? "Joining…" : "Join room"}
                  </button>
                )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
