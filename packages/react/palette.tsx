/**
 * The command palette: every command, plus things that depend on what you
 * are doing — add a component the selection lacks, jump to an entity, open a
 * scene, create from a preset.
 */
import { useEffect, useMemo, useState } from "react";
import { defaultRecord } from "@ink/schema";
import { type Ink, useInk, useUi } from "./context.tsx";
import { type Command, shortcutLabel } from "./commands.ts";
import { componentIcon, Icon } from "./icons.tsx";
import type { Preset } from "./outliner.tsx";

function contextual(ink: Ink, presets: Preset[]): Command[] {
  const { session } = ink;
  const out: Command[] = [];
  const selected = session.selection.map((id) => session.entity(id)).filter(
    Boolean,
  );
  if (selected.length > 0) {
    for (const c of session.schema.components) {
      if (c.hidden || selected.every((e) => e!.components[c.name])) continue;
      out.push({
        id: `add-${c.name}`,
        label: `Add ${c.name.replace(/_/g, " ")} to selection`,
        icon: componentIcon(c.name, c.icon),
        group: "Selection",
        run: () => {
          session.edit(`Add ${c.name}`, (world) => {
            for (const id of session.selection) {
              const e = world.entities.find((x) => x.id === id);
              if (e && !e.components[c.name]) {
                e.components[c.name] = defaultRecord(c);
              }
            }
          });
        },
      });
    }
  }
  for (const preset of presets) {
    out.push({
      id: `create-${preset.label}`,
      label: `Create ${preset.label}`,
      icon: preset.icon ?? "plus",
      group: "Create",
      run: () => {
        session.createEntity({
          name: preset.name ?? preset.label,
          components: preset.components,
        });
      },
    });
  }
  for (const entity of session.world.entities) {
    out.push({
      id: `entity-${entity.id}`,
      label: `Go to ${session.nameOf(entity.id)}`,
      icon: "entity",
      group: "Entities",
      run: () => session.select([entity.id]),
    });
  }
  for (const scene of ink.dev?.project.scenes ?? []) {
    out.push({
      id: `scene-${scene}`,
      label: `Open scene ${scene}`,
      icon: "file",
      group: "Scenes",
      run: () => ink.dev?.openScene(scene),
    });
  }
  return out;
}

function score(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t.includes(q)) return 2 + (t.startsWith(q) ? 1 : 0) - t.length / 1000;
  // Subsequence match.
  let at = 0;
  for (const ch of q) {
    at = t.indexOf(ch, at);
    if (at < 0) return 0;
    at++;
  }
  return 1 - t.length / 1000;
}

export function CommandPalette(
  { commands, presets = [] }: { commands: Command[]; presets?: Preset[] },
) {
  const ink = useInk();
  const open = useUi((u) => u.palette);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);
  const items = useMemo(() => {
    if (!open) return [];
    const all = [
      ...commands.filter((c) => !c.enabled || c.enabled(ink)),
      ...contextual(ink, presets),
    ];
    return all.map((c) => ({
      c,
      s: score(`${c.group ?? ""} ${c.label}`, query),
    })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s).slice(0, 60).map((x) => x.c);
  }, [open, query, commands]);
  if (!open) return null;
  const close = () => ink.ui.set({ palette: false });
  const run = (command: Command) => {
    close();
    command.run(ink);
  };
  return (
    <div
      className="ink-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="ink-palette">
        <input
          autoFocus
          placeholder="Type a command, an entity or a component…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
            if (e.key === "ArrowDown") {setActive((a) =>
                Math.min(items.length - 1, a + 1)
              );}
            if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
            if (e.key === "Enter" && items[active]) run(items[active]);
          }}
        />
        <div className="ink-palette-list">
          {items.length === 0 && (
            <div className="ink-empty">Nothing matches.</div>
          )}
          {items.map((command, i) => (
            <button
              type="button"
              key={command.id}
              className="ink-menu-item"
              data-active={i === active}
              onPointerEnter={() => setActive(i)}
              onClick={() => run(command)}
            >
              <Icon name={command.icon ?? "dot"} size={13} />
              <span style={{ flex: 1 }}>{command.label}</span>
              {command.group && (
                <span className="ink-row-meta">{command.group}</span>
              )}
              {command.shortcut && (
                <span className="ink-kbd">
                  {shortcutLabel(command.shortcut)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
