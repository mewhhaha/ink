import { useState } from "react";
import {
  type Command,
  commandShortcuts,
  matchShortcut,
  shortcutFromEvent,
} from "./commands.ts";
import { useInk, useUi } from "./context.tsx";

export function ShortcutSettings({ commands }: { commands: Command[] }) {
  const ink = useInk();
  const open = useUi((u) => u.shortcutSettings);
  const overrides = useUi((u) => u.shortcuts);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  if (!open) return null;
  return (
    <div
      className="ink-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          ink.ui.set({
            shortcutSettings: false,
          });
        }
      }}
    >
      <section
        className="ink-palette"
        role="dialog"
        aria-label="Keyboard shortcuts"
        style={{ width: 620 }}
      >
        <header className="ink-panel-header">
          <b>Keyboard shortcuts</b>
          <span className="ink-bar-spacer" />
          <button
            type="button"
            className="ink-button"
            onClick={() => {
              ink.ui.set({ shortcuts: {} });
              setError("");
            }}
          >
            Reset defaults
          </button>
          <button
            type="button"
            className="ink-button"
            onClick={() => ink.ui.set({ shortcutSettings: false })}
          >
            Close
          </button>
        </header>
        <input
          className="ink-input"
          aria-label="Filter shortcuts"
          placeholder="Filter commands"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <p style={{ margin: 10, color: "var(--ink-muted)" }}>
          Focus a shortcut and press its new keys. Backspace clears it. Changes
          save automatically.
        </p>
        {error && (
          <p role="alert" style={{ margin: 10, color: "var(--ink-danger)" }}>
            {error}
          </p>
        )}
        <div style={{ overflow: "auto", maxHeight: "55vh", padding: 10 }}>
          {commands.filter((c) =>
            c.label.toLowerCase().includes(filter.toLowerCase())
          ).map((command) => (
            <label key={command.id} className="ink-comment-controls">
              <span style={{ flex: 2 }}>{command.label}</span>
              <input
                className="ink-input"
                aria-label={`Shortcut for ${command.label}`}
                readOnly
                value={commandShortcuts(command, overrides).join(", ")}
                placeholder="Unbound"
                onKeyDown={(e) => {
                  if (e.key === "Tab") {
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  const key = e.key === "Backspace"
                    ? ""
                    : shortcutFromEvent(e.nativeEvent);
                  if (key === null) {
                    return;
                  }
                  const conflict = key && commands.find((c) =>
                    c.id !== command.id &&
                    commandShortcuts(c, overrides).some((binding) =>
                      matchShortcut(e.nativeEvent, binding)
                    )
                  );
                  if (conflict) {
                    setError(
                      `${key} is assigned to ${conflict.label}. Clear that binding first.`,
                    );
                    return;
                  }
                  setError("");
                  ink.ui.set({
                    shortcuts: { ...overrides, [command.id]: key ? [key] : [] },
                  });
                }}
              />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
