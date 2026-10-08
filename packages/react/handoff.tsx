/**
 * The hand-off dialog: write what you want, pick screenshots of the views on
 * screen, and save everything an agent needs under `.ink/handoffs/<id>/`.
 * A ready-to-paste prompt goes to the clipboard.
 */
import { useEffect, useState } from "react";
import { buildHandoff } from "@ink/core";
import { useInk, useUi } from "./context.tsx";
import { Icon } from "./icons.tsx";

interface Shot {
  id: string;
  label: string;
  png: string;
  include: boolean;
}

export function HandoffDialog() {
  const ink = useInk();
  const open = useUi((u) => u.handoff);
  const [note, setNote] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ dir: string; prompt: string } | null>(
    null,
  );

  useEffect(() => {
    if (!open) return;
    setDone(null);
    // Freeze the moment: pause a running game while writing.
    if (ink.session.mode === "play") ink.session.pause();
    Promise.all(
      [...ink.views.values()].map(async (view, i) => ({
        id: view.id,
        label: view.label,
        png: await view.capture(),
        include: i < 2,
      })),
    ).then(setShots).catch((error) =>
      ink.session.warn(`screenshot failed: ${error}`)
    );
  }, [open]);

  if (!open) return null;
  const close = () => ink.ui.set({ handoff: false });
  const send = async () => {
    if (!ink.dev) {
      ink.session.error("hand-offs need the Ink dev server");
      return;
    }
    setBusy(true);
    try {
      const included = shots.filter((s) => s.include);
      const main = included[0]
        ? ink.views.get(included[0].id)?.pose() ?? undefined
        : undefined;
      const handoff = buildHandoff(ink.session, {
        note,
        project: ink.project,
        view: main,
        screenshots: included.map((s) => ({
          name: s.id,
          png: s.png,
          caption: `${s.label} view`,
        })),
      });
      const result = await ink.dev.client.postHandoff(
        handoff.files,
        handoff.id,
      );
      const path = `${ink.project}/${result.dir}/handoff.md`;
      const prompt =
        `Please read ${path} — it has my note, screenshots, the exact game state and how to reproduce it.`;
      await navigator.clipboard.writeText(prompt).catch(() => {});
      ink.session.info(`hand-off saved to ${result.dir}`, "dev");
      setDone({ dir: result.dir, prompt });
      setNote("");
    } catch (error) {
      ink.session.error(`hand-off failed: ${error}`, "dev");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="ink-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="ink-dialog" onKeyDown={(e) => e.stopPropagation()}>
        <div className="ink-dialog-head">
          <Icon name="send" /> Hand off to an agent
        </div>
        {done
          ? (
            <div className="ink-dialog-body">
              <p>
                Saved to{" "}
                <code>{done.dir}</code>. This prompt is on your clipboard:
              </p>
              <textarea
                className="ink-input"
                readOnly
                rows={3}
                value={done.prompt}
                onFocus={(e) => e.target.select()}
              />
            </div>
          )
          : (
            <div className="ink-dialog-body">
              <p>
                The agent gets your note, the screenshots, the world at tick
                {" "}
                {ink.session.tick}, a replay of the last seconds, open comments,
                the console and build errors.
              </p>
              <textarea
                className="ink-input"
                autoFocus
                rows={5}
                placeholder="What should the agent look at or change? e.g. “The player slides off the ramp here; make movement stick to slopes.”"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
                  if (e.key === "Escape") close();
                }}
              />
              <div className="ink-shots">
                {shots.map((shot) => (
                  <button
                    type="button"
                    key={shot.id}
                    className="ink-shot"
                    aria-pressed={shot.include}
                    onClick={() =>
                      setShots(shots.map((s) => (s.id === shot.id
                        ? { ...s, include: !s.include }
                        : s)
                      ))}
                  >
                    <img src={shot.png} alt={shot.label} />
                    <span>{shot.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        <div className="ink-dialog-foot">
          <button type="button" className="ink-button" onClick={close}>
            {done ? "Close" : "Cancel"}
          </button>
          {!done && (
            <button
              type="button"
              className="ink-button"
              data-variant="primary"
              disabled={busy}
              onClick={send}
            >
              {busy ? "Saving…" : "Save hand-off"}{" "}
              <span className="ink-kbd" style={{ color: "inherit" }}>
                Ctrl ↵
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
