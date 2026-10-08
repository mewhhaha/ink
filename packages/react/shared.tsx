import { useState, useSyncExternalStore } from "react";
import { type CameraPose, type Session, SharedSession } from "@ink/core";
import { mat4, type Vec3 } from "@ink/geometry";
import type { Line, RenderScene } from "@ink/render";
import { useInk, useSessionValue } from "./context.tsx";

const connections = new WeakMap<Session, SharedSession>();
const noop = () => () => {};

export function SharedControls() {
  const ink = useInk();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(() =>
    localStorage.getItem("ink:display-name") ?? "Guest"
  );
  const [current, setCurrent] = useState(() => connections.get(ink.session));
  const [error, setError] = useState("");
  useSyncExternalStore(current?.subscribe ?? noop, () => current?.version ?? 0);
  const scene = useSessionValue((s) => s.sceneName);
  const driver = useSessionValue((s) => s.documentDriver);
  const active = driver === current && !!current?.available;
  const join = () => {
    if (!ink.dev) return;
    setError("");
    try {
      localStorage.setItem("ink:display-name", name);
      const channel = ink.dev.client.shared((message) =>
        shared.receive(message)
      );
      const shared = new SharedSession(ink.session, channel, () => {
        const cameras: Record<string, CameraPose> = {};
        for (const [id, view] of ink.views) {
          const pose = view.pose();
          if (pose) cameras[id] = pose;
        }
        return { selection: [...ink.session.selection], cameras };
      });
      connections.set(ink.session, shared);
      setCurrent(shared);
      shared.join(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const leave = () => {
    current?.dispose();
    connections.delete(ink.session);
    setCurrent(undefined);
  };
  return (
    <>
      <button
        type="button"
        className="ink-button"
        onClick={() => setOpen(true)}
        title="Share this scene with other editors"
      >
        {active
          ? `${current.peers.length} editing`
          : current?.error
          ? "Sharing disconnected"
          : "Share scene"}
      </button>
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
            aria-label="Shared editing"
            style={{ width: 480 }}
          >
            <header className="ink-panel-header">
              <b>Shared editing · {scene}</b>
              <span className="ink-bar-spacer" />
              <button
                className="ink-button"
                type="button"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </header>
            <div style={{ padding: 18, display: "grid", gap: 14 }}>
              <p style={{ margin: 0, color: "var(--ink-muted)" }}>
                Join this scene from another browser to edit together. Changes
                and comments save automatically; each person keeps their
                selection, cameras and undo history.
              </p>
              {!current && (
                <>
                  <label>
                    Your name{" "}
                    <input
                      className="ink-input"
                      aria-label="Your name"
                      maxLength={48}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <button
                    className="ink-button"
                    type="button"
                    disabled={!name.trim()}
                    onClick={join}
                  >
                    Join shared scene
                  </button>
                </>
              )}
              {current && (
                <>
                  {!active && !current.error && (
                    <p role="status">Joining the shared scene…</p>
                  )}
                  {current.peers.map((peer) => (
                    <div
                      key={peer.actor}
                      style={{
                        borderLeft: `3px solid ${peer.color}`,
                        paddingLeft: 10,
                      }}
                    >
                      <b>
                        {peer.name}
                        {peer.actor === current.actor ? " (you)" : ""}
                      </b>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--ink-muted)",
                          marginTop: 4,
                        }}
                      >
                        {peer.selection.length
                          ? peer.selection.map((id) => ink.session.nameOf(id))
                            .join(", ")
                          : "No selection"}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--ink-faint)",
                          marginTop: 4,
                        }}
                      >
                        {Object.entries(peer.cameras).map(([view, pose]) =>
                          `${view}: ${
                            pose.position.map((n) => n.toFixed(1)).join(", ")
                          }`
                        ).join(" · ")}
                      </div>
                    </div>
                  ))}
                  <button className="ink-button" type="button" onClick={leave}>
                    Leave shared scene
                  </button>
                </>
              )}
              {(error || current?.error) && (
                <p
                  role="alert"
                  style={{ color: "var(--ink-danger)", margin: 0 }}
                >
                  {error || current?.error}
                </p>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

/** Other users' selection marks are overlays, never entity components. */
export function sharedSelectionLines(
  session: Session,
  scene: RenderScene,
): Line[] {
  const shared = session.documentDriver;
  if (!(shared instanceof SharedSession)) return [];
  const lines: Line[] = [];
  for (const peer of shared.peers) {
    if (peer.actor === shared.actor) continue;
    const rgb = [1, 3, 5].map((offset) =>
      parseInt(peer.color.slice(offset, offset + 2), 16) / 255
    );
    const color: [number, number, number, number] = [
      rgb[0],
      rgb[1],
      rgb[2],
      0.85,
    ];
    for (const id of peer.selection) {
      const matrix = scene.matrices.get(id);
      if (!matrix) continue;
      const bounds = scene.brushes.find((b) =>
        b.entity === id
      )?.geometry.bounds ??
        { min: [-0.55, -0.55, -0.55], max: [0.55, 0.55, 0.55] };
      const points = Array.from({ length: 8 }, (_, i) =>
        mat4.transformPoint(
          matrix,
          [0, 1, 2].map((axis) =>
            i & (1 << axis) ? bounds.max[axis] : bounds.min[axis]
          ) as Vec3,
        ));
      for (let i = 0; i < 8; i++) {
        for (let axis = 0; axis < 3; axis++) {
          if (!(i & (1 << axis))) {
            lines.push({
              from: points[i],
              to: points[i | (1 << axis)],
              color,
              width: 2,
            });
          }
        }
      }
    }
  }
  return lines;
}
