/** Toolbar pieces: compose them into whatever bar an editor needs. */
import type { ReactNode } from "react";
import { useInk, useSession, useSessionValue, useUi } from "./context.tsx";
import { Icon } from "./icons.tsx";
import { useDropdown } from "./menu.tsx";
import type { ViewportTool } from "./viewport.tsx";
import { shortcutLabel } from "./commands.ts";

export function TopBar({ children }: { children: ReactNode }) {
  return <div className="ink-bar">{children}</div>;
}

export function Group({ children }: { children: ReactNode }) {
  return <div className="ink-bar-group">{children}</div>;
}

export function Spacer() {
  return <div className="ink-bar-spacer" />;
}

export function Brand(
  { title, subtitle }: { title?: string; subtitle?: string },
) {
  const ink = useInk();
  return (
    <div className="ink-brand">
      <span className="ink-brand-mark" />
      <span>{title ?? ink.title}</span>
      {subtitle && <small>{subtitle}</small>}
    </div>
  );
}

export function ToolButton(props: {
  icon: string;
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  variant?: string;
  text?: ReactNode;
  onClick(event: React.MouseEvent<HTMLButtonElement>): void;
}) {
  return (
    <button
      type="button"
      className="ink-button"
      data-icon-only={props.text === undefined}
      data-variant={props.variant}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      title={props.shortcut
        ? `${props.label} (${shortcutLabel(props.shortcut)})`
        : props.label}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
      {props.text}
    </button>
  );
}

export function PlayControls() {
  const session = useSession();
  const { mode, paused, canStep } = useSessionValue(
    (s) => ({ mode: s.mode, paused: s.paused, canStep: s.canStep }),
    (a, b) =>
      a.mode === b.mode && a.paused === b.paused && a.canStep === b.canStep,
  );
  const playing = mode === "play";
  return (
    <Group>
      <ToolButton
        icon={playing ? "stop" : "play"}
        label={playing ? "Stop" : "Play"}
        shortcut="F5"
        variant="play"
        pressed={playing}
        onClick={() => (playing ? session.stop() : session.play())}
      />
      <ToolButton
        icon={paused ? "play" : "pause"}
        label={paused ? "Resume" : "Pause"}
        shortcut="F6"
        pressed={playing && paused}
        disabled={!playing}
        onClick={() => session.togglePause()}
      />
      <ToolButton
        icon="step"
        label="Step"
        shortcut="F7"
        disabled={!playing || !canStep}
        onClick={() => session.stepFrame()}
      />
    </Group>
  );
}

const builtinTools = [
  { id: "select", label: "Select", icon: "select", shortcut: "Q" },
  { id: "move", label: "Move", icon: "move", shortcut: "W" },
  { id: "rotate", label: "Rotate", icon: "rotate", shortcut: "E" },
  { id: "scale", label: "Scale", icon: "scale", shortcut: "R" },
];

export function ToolPicker(
  { tools = [], builtins = true }: {
    tools?: ViewportTool[];
    builtins?: boolean;
  },
) {
  const ink = useInk();
  const tool = useUi((u) => u.tool);
  const all = [
    ...(builtins ? builtinTools : []),
    ...tools.map((t) => ({
      id: t.id,
      label: t.label,
      icon: t.icon ?? "wand",
      shortcut: t.shortcut,
    })),
  ];
  return (
    <Group>
      {all.map((t) => (
        <ToolButton
          key={t.id}
          icon={t.icon}
          label={t.label}
          shortcut={t.shortcut}
          pressed={tool === t.id}
          onClick={() => ink.ui.set({ tool: t.id as never })}
        />
      ))}
    </Group>
  );
}

export function SnapControls() {
  const ink = useInk();
  const { snap, grid } = useUi((u) => ({ snap: u.snap, grid: u.grid }));
  const dropdown = useDropdown();
  const sizes = [1 / 16, 1 / 8, 0.25, 0.5, 1, 2, 4, 8, 16];
  return (
    <Group>
      <ToolButton
        icon="magnet"
        label="Snap to grid"
        shortcut="G"
        pressed={snap}
        onClick={() => ink.ui.set({ snap: !snap })}
      />
      <button
        type="button"
        className="ink-button"
        title="Grid size ([ and ])"
        onClick={(e) =>
          dropdown(
            e.currentTarget,
            sizes.map((s) => ({
              label: `${s}`,
              icon: s === grid ? "check" : undefined,
              run: () => ink.ui.set({ grid: s }),
            })),
          )}
      >
        <Icon name="grid" /> {grid}
      </button>
    </Group>
  );
}

export function HistoryButtons() {
  const session = useSession();
  const { undo, redo } = useSessionValue(
    (s) => ({ undo: s.canUndo, redo: s.canRedo }),
    (a, b) => a.undo === b.undo && a.redo === b.redo,
  );
  const history = useSessionValue(
    (s) => s.history(),
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );
  return (
    <Group>
      <ToolButton
        icon="undo"
        label={`Undo ${history.undo.at(-1) ?? ""}`.trim()}
        shortcut="Ctrl+Z"
        disabled={!undo}
        onClick={() => session.undo()}
      />
      <ToolButton
        icon="redo"
        label={`Redo ${history.redo.at(-1) ?? ""}`.trim()}
        shortcut="Ctrl+Shift+Z"
        disabled={!redo}
        onClick={() => session.redo()}
      />
    </Group>
  );
}

export function SaveButton() {
  const ink = useInk();
  const { dirty, name, pending } = useSessionValue(
    (s) => ({
      dirty: s.dirty,
      name: s.sceneName,
      pending: s.pendingScene !== null,
    }),
    (a, b) =>
      a.dirty === b.dirty && a.name === b.name && a.pending === b.pending,
  );
  const dropdown = useDropdown();
  return (
    <Group>
      <button
        type="button"
        className="ink-button"
        title="Scenes"
        onClick={async (e) => {
          const target = e.currentTarget;
          const scenes = (await ink.dev?.client.scenes()) ?? [];
          dropdown(target, [
            { heading: "Scenes" },
            ...scenes.map((s) => ({
              label: s,
              icon: s === name ? "check" : "file",
              run: () => ink.dev?.openScene(s),
            })),
          ]);
        }}
      >
        <Icon name="file" /> {name}
        {dirty && <span style={{ color: "var(--ink-warn)" }}>●</span>}
      </button>
      {pending && (
        <ToolButton
          icon="alert"
          label="Scene changed on disk — load it"
          variant="danger"
          onClick={() => ink.session.acceptPendingScene()}
        />
      )}
      <ToolButton
        icon="save"
        label="Save scene"
        shortcut="Ctrl+S"
        disabled={!dirty}
        onClick={() => ink.dev?.saveScene()}
      />
    </Group>
  );
}

export function BuildStatus() {
  const status = useSessionValue((s) => s.status);
  const text = status.kind === "ready"
    ? `rev ${status.revision}${
      status.ms !== undefined ? ` · ${Math.round(status.ms)} ms` : ""
    }`
    : status.kind === "error"
    ? `${status.diagnostics.length} error${
      status.diagnostics.length === 1 ? "" : "s"
    }`
    : status.kind === "building"
    ? "building…"
    : "no game";
  return (
    <span className="ink-status" title="Blot build">
      <span className="ink-status-dot" data-kind={status.kind} />
      {text}
    </span>
  );
}

export function CollaborateButtons() {
  const ink = useInk();
  const commenting = useUi((u) => u.commenting);
  const open = useSessionValue((s) =>
    s.comments.filter((c) => c.status !== "resolved").length
  );
  return (
    <Group>
      <ToolButton
        icon="comment"
        label="Comment mode: click in a view to pin a comment"
        shortcut="C"
        pressed={commenting}
        text={open > 0 ? <span className="ink-chip">{open}</span> : undefined}
        onClick={() => ink.ui.set({ commenting: !commenting })}
      />
      <ToolButton
        icon="send"
        label="Hand off to an agent"
        shortcut="Ctrl+Shift+H"
        text="Hand off"
        onClick={() => ink.ui.set({ handoff: true })}
      />
      <ToolButton
        icon="comment"
        label="Comment queue"
        text="Comments"
        onClick={() => ink.ui.set({ comments: !ink.ui.get().comments })}
      />
    </Group>
  );
}

export function LayoutButton() {
  const ink = useInk();
  const layout = useUi((u) => u.layout);
  return (
    <ToolButton
      icon={layout === "editor" ? "maximize" : "minimize"}
      label={layout === "editor" ? "Flip to the game" : "Back to the editor"}
      shortcut="Ctrl+G"
      onClick={() =>
        ink.ui.set({ layout: layout === "editor" ? "game" : "editor" })}
    />
  );
}

export function PaletteButton() {
  const ink = useInk();
  return (
    <ToolButton
      icon="search"
      label="Command palette"
      shortcut="Ctrl+K"
      onClick={() => ink.ui.set({ palette: true })}
    />
  );
}
