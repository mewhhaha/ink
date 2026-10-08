/**
 * Commands are the verbs of an editor: they back hotkeys, toolbar buttons
 * and the command palette. Apps add their own next to the built-in ones.
 */
import type { Ink } from "./context.tsx";

export interface Command {
  id: string;
  label: string;
  icon?: string;
  /** e.g. "Ctrl+Shift+Z", "F5", "Delete", "W". Ctrl also matches Cmd. */
  shortcut?: string | string[];
  group?: string;
  /** Allowed while typing in a text field. */
  global?: boolean;
  enabled?(ink: Ink): boolean;
  run(ink: Ink): void | Promise<void>;
}

export function matchShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split("+");
  const key = parts.pop()!;
  const want = new Set(parts.map((p) => p.toLowerCase()));
  if (want.has("ctrl") !== (event.ctrlKey || event.metaKey)) return false;
  if (want.has("shift") !== event.shiftKey) return false;
  if (want.has("alt") !== event.altKey) return false;
  const code = event.code;
  if (key.length === 1 && /[A-Z]/.test(key)) return code === `Key${key}`;
  if (key.length === 1 && /[0-9]/.test(key)) return code === `Digit${key}`;
  if (key === "`") return code === "Backquote";
  return event.key === key || code === key;
}

export const shortcutLabel = (shortcut?: string | string[]) =>
  (Array.isArray(shortcut) ? shortcut[0] : shortcut)?.replace(
    "Ctrl",
    navigator.platform.includes("Mac") ? "⌘" : "Ctrl",
  );

export const builtinCommands: Command[] = [
  {
    id: "play",
    label: "Play / stop",
    icon: "play",
    shortcut: "F5",
    group: "Play",
    global: true,
    run: (
      { session },
    ) => (session.mode === "play" ? session.stop() : session.play()),
  },
  {
    id: "pause",
    label: "Pause / resume",
    icon: "pause",
    shortcut: "F6",
    group: "Play",
    global: true,
    enabled: ({ session }) => session.mode === "play",
    run: ({ session }) => session.togglePause(),
  },
  {
    id: "step",
    label: "Step one frame",
    icon: "step",
    shortcut: "F7",
    group: "Play",
    global: true,
    enabled: ({ session }) => session.mode === "play",
    run: ({ session }) => session.stepFrame(),
  },
  {
    id: "restart",
    label: "Restart play",
    icon: "rotate",
    group: "Play",
    run: ({ session }) => session.restart(),
  },
  {
    id: "apply",
    label: "Apply play changes to the scene",
    icon: "check",
    shortcut: "Ctrl+Shift+A",
    group: "Play",
    enabled: ({ session }) => session.mode === "play",
    run: ({ session }) =>
      session.applyToDocument(
        session.selection.length ? session.selection : undefined,
      ),
  },
  {
    id: "undo",
    label: "Undo",
    icon: "undo",
    shortcut: "Ctrl+Z",
    group: "Edit",
    run: ({ session }) => session.undo(),
  },
  {
    id: "redo",
    label: "Redo",
    icon: "redo",
    shortcut: ["Ctrl+Shift+Z", "Ctrl+Y"],
    group: "Edit",
    run: ({ session }) => session.redo(),
  },
  {
    id: "save",
    label: "Save scene",
    icon: "save",
    shortcut: "Ctrl+S",
    group: "File",
    global: true,
    run: (ink) => ink.dev?.saveScene(),
  },
  {
    id: "delete",
    label: "Delete selection",
    icon: "trash",
    shortcut: ["Delete", "Backspace"],
    group: "Edit",
    enabled: ({ session }) => session.selection.length > 0,
    run: ({ session }) => session.deleteEntities(session.selection),
  },
  {
    id: "duplicate",
    label: "Duplicate selection",
    icon: "copy",
    shortcut: "Ctrl+D",
    group: "Edit",
    enabled: ({ session }) => session.selection.length > 0,
    run: ({ session }) => {
      session.duplicateEntities(session.selection);
    },
  },
  {
    id: "select-all",
    label: "Select all",
    shortcut: "Ctrl+A",
    group: "Edit",
    run: ({ session }) =>
      session.select(session.world.entities.map((e) => e.id)),
  },
  {
    id: "deselect",
    label: "Clear selection",
    shortcut: "Escape",
    group: "Edit",
    run: (ink) => {
      if (ink.ui.get().commenting) ink.ui.set({ commenting: false });
      else ink.session.select([]);
    },
  },
  {
    id: "tool-select",
    label: "Select tool",
    icon: "select",
    shortcut: "Q",
    group: "Tools",
    run: ({ ui }) => ui.set({ tool: "select" }),
  },
  {
    id: "tool-move",
    label: "Move tool",
    icon: "move",
    shortcut: "W",
    group: "Tools",
    run: ({ ui }) => ui.set({ tool: "move" }),
  },
  {
    id: "tool-rotate",
    label: "Rotate tool",
    icon: "rotate",
    shortcut: "E",
    group: "Tools",
    run: ({ ui }) => ui.set({ tool: "rotate" }),
  },
  {
    id: "tool-scale",
    label: "Scale tool",
    icon: "scale",
    shortcut: "R",
    group: "Tools",
    run: ({ ui }) => ui.set({ tool: "scale" }),
  },
  {
    id: "snap",
    label: "Toggle grid snapping",
    icon: "magnet",
    shortcut: "G",
    group: "Tools",
    run: ({ ui }) => ui.set((u) => ({ snap: !u.snap })),
  },
  {
    id: "grid-smaller",
    label: "Smaller grid",
    shortcut: "[",
    group: "Tools",
    run: ({ ui }) => ui.set((u) => ({ grid: Math.max(1 / 64, u.grid / 2) })),
  },
  {
    id: "grid-larger",
    label: "Larger grid",
    shortcut: "]",
    group: "Tools",
    run: ({ ui }) => ui.set((u) => ({ grid: Math.min(64, u.grid * 2) })),
  },
  {
    id: "comment",
    label: "Comment mode",
    icon: "comment",
    shortcut: "C",
    group: "Collaborate",
    run: ({ ui }) => ui.set((u) => ({ commenting: !u.commenting })),
  },
  {
    id: "handoff",
    label: "Hand off to an agent…",
    icon: "send",
    shortcut: "Ctrl+Shift+H",
    group: "Collaborate",
    global: true,
    run: ({ ui }) => ui.set({ handoff: true }),
  },
  {
    id: "layout",
    label: "Flip between editor and game",
    icon: "maximize",
    shortcut: "Ctrl+G",
    group: "View",
    global: true,
    run: ({ ui }) =>
      ui.set((u) => ({ layout: u.layout === "editor" ? "game" : "editor" })),
  },
  {
    id: "palette",
    label: "Command palette",
    icon: "search",
    shortcut: "Ctrl+K",
    group: "View",
    global: true,
    run: ({ ui }) => ui.set((u) => ({ palette: !u.palette })),
  },
];
