/**
 * The entity tree: selection, rename, drag to reparent or reorder, context
 * menu, search. Entities created by the running game show up while playing.
 */
import { useMemo, useState } from "react";
import type { EntityModel } from "@ink/schema";
import { arrayEqual, useSession, useSessionValue } from "./context.tsx";
import { componentIcon, Icon } from "./icons.tsx";
import { type MenuItem, useMenu } from "./menu.tsx";

export interface Preset {
  label: string;
  icon?: string;
  name?: string;
  /** Scene-style components: asset paths like "builtin:cube", fields optional. */
  components: Record<string, Record<string, unknown>>;
}

interface Row {
  id: number;
  depth: number;
  name: string;
  icon: string;
  hasChildren: boolean;
  meta?: string;
}

/** Icon for an entity from its most telling component. */
export function entityIcon(
  components: Record<string, unknown>,
  icons: Record<string, string | undefined> = {},
): string {
  for (const name of ["camera", "light", "brush", "mesh"]) {
    if (name === "light" && components.light) {
      const kind = (components.light as { kind?: string }).kind;
      return kind === "point" ? "bulb" : kind === "spot" ? "spotlight" : "sun";
    }
    if (components[name]) return componentIcon(name);
  }
  const custom = Object.keys(components).find((c) => c !== "transform");
  return custom ? componentIcon(custom, icons[custom]) : "entity";
}

export function Outliner(
  props: { presets?: Preset[]; filter?: (entity: EntityModel) => boolean },
) {
  const session = useSession();
  const menu = useMenu();
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [drop, setDrop] = useState<
    { id: number; where: "inside" | "before" } | null
  >(null);
  const selection = useSessionValue((s) => s.selection);
  const hovered = useSessionValue((s) => s.hovered);
  const filter = props.filter;

  // Only structure and names matter here, not every field of every step.
  const structure = useSessionValue(
    (s) => {
      const icons = Object.fromEntries(
        s.schema.components.map((c) => [c.name, c.icon]),
      );
      return s.world.entities.filter((e) => !filter || filter(e)).map((e) => ({
        id: e.id,
        parent: e.parent,
        name: s.nameOf(e.id),
        named: s.names.has(e.id),
        icon: entityIcon(e.components, icons),
      }));
    },
    (a, b) =>
      a.length === b.length &&
      a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i])),
  );

  const rows = useMemo(() => {
    const children = new Map<number, typeof structure>();
    const ids = new Set(structure.map((e) => e.id));
    for (const e of structure) {
      const parent = ids.has(e.parent) ? e.parent : 0;
      children.set(parent, [...(children.get(parent) ?? []), e]);
    }
    const out: Row[] = [];
    const q = query.trim().toLowerCase();
    const matches = (id: number): boolean => {
      const e = structure.find((x) => x.id === id)!;
      return e.name.toLowerCase().includes(q) ||
        (children.get(id) ?? []).some((c) => matches(c.id));
    };
    const walk = (parent: number, depth: number) => {
      for (const e of children.get(parent) ?? []) {
        if (q && !matches(e.id)) continue;
        const kids = children.get(e.id) ?? [];
        out.push({
          id: e.id,
          depth,
          name: e.name,
          icon: e.icon,
          hasChildren: kids.length > 0,
          meta: e.named ? undefined : `#${e.id}`,
        });
        if (!collapsed.has(e.id) || q) walk(e.id, depth + 1);
      }
    };
    walk(0, 0);
    return out;
  }, [structure, collapsed, query]);

  const rowMenu = (id: number): MenuItem[] => {
    const targets = selection.includes(id) ? selection : [id];
    return [
      {
        label: "Rename",
        icon: "file",
        shortcut: "F2",
        run: () => setRenaming(id),
      },
      {
        label: "Duplicate",
        icon: "copy",
        shortcut: "Ctrl D",
        run: () => session.duplicateEntities(targets),
      },
      ...(props.presets?.length ? [{ heading: "Add child" } as MenuItem] : []),
      ...(props.presets ?? []).map((preset): MenuItem => ({
        label: preset.label,
        icon: preset.icon,
        run: () =>
          session.createEntity({
            name: preset.name ?? preset.label,
            parent: id,
            components: preset.components,
          }),
      })),
      { separator: true },
      {
        label: "Unparent",
        icon: "layers",
        run: () => session.reparent(targets, 0),
      },
      {
        label: "Delete",
        icon: "trash",
        shortcut: "Del",
        danger: true,
        run: () => session.deleteEntities(targets),
      },
    ];
  };
  const backgroundMenu = (): MenuItem[] =>
    (props.presets ?? []).map((preset) => ({
      label: `New ${preset.label}`,
      icon: preset.icon,
      run: () =>
        session.createEntity({
          name: preset.name ?? preset.label,
          components: preset.components,
        }),
    }));

  const onRowClick = (event: React.MouseEvent, id: number) => {
    if (event.shiftKey && selection.length > 0) {
      const from = rows.findIndex((r) =>
        r.id === selection[selection.length - 1]
      );
      const to = rows.findIndex((r) => r.id === id);
      const [a, b] = from < to ? [from, to] : [to, from];
      session.select(rows.slice(a, b + 1).map((r) => r.id), "add");
    } else if (event.ctrlKey || event.metaKey) session.select([id], "toggle");
    else session.select([id]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "6px 8px", display: "flex", gap: 4 }}>
        <input
          className="ink-input"
          placeholder="Filter"
          value={query}
          onChange={(e) =>
            setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div
        className="ink-tree"
        tabIndex={0}
        style={{ flex: 1, overflow: "auto" }}
        onContextMenu={props.presets?.length ? menu(backgroundMenu) : undefined}
        onDragOver={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
          }
        }}
        onDrop={(e) => {
          if (e.target !== e.currentTarget) return;
          const ids = JSON.parse(
            e.dataTransfer.getData("application/x-ink-entities") || "[]",
          );
          if (ids.length) session.reparent(ids, 0);
        }}
        onKeyDown={(e) => {
          const at = rows.findIndex((r) => r.id === selection[0]);
          if (e.key === "F2" && selection[0]) setRenaming(selection[0]);
          else if (e.key === "ArrowDown" && at < rows.length - 1) {
            session
              .select([
                rows[at + 1].id,
              ]);
          } else if (e.key === "ArrowUp" && at > 0) {
            session.select([
              rows[at - 1].id,
            ]);
          } else if (e.key === "ArrowLeft" && at >= 0) {
            setCollapsed(
              new Set(collapsed).add(rows[at].id),
            );
          } else if (e.key === "ArrowRight" && at >= 0) {
            const next = new Set(collapsed);
            next.delete(rows[at].id);
            setCollapsed(next);
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {rows.length === 0 && (
          <div className="ink-empty">
            {query ? "No matches" : "No entities. Right-click to add one."}
          </div>
        )}
        {rows.map((row) => (
          <div
            key={row.id}
            className="ink-row"
            aria-selected={selection.includes(row.id)}
            data-hovered={hovered === row.id}
            data-drop={drop?.id === row.id ? drop.where : undefined}
            style={{ paddingLeft: 6 + row.depth * 14 }}
            draggable={renaming !== row.id}
            onDragStart={(e) => {
              const ids = selection.includes(row.id) ? selection : [row.id];
              e.dataTransfer.setData(
                "application/x-ink-entities",
                JSON.stringify(ids),
              );
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              setDrop({
                id: row.id,
                where: e.clientY - rect.top < rect.height * 0.3
                  ? "before"
                  : "inside",
              });
            }}
            onDragLeave={() => setDrop(null)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDrop(null);
              const ids: number[] = JSON.parse(
                e.dataTransfer.getData("application/x-ink-entities") || "[]",
              );
              if (!ids.length || ids.includes(row.id)) return;
              if (drop?.where === "before") {
                const parent = structure.find((x) => x.id === row.id)?.parent ??
                  0;
                session.reparent(ids, parent, row.id);
              } else session.reparent(ids, row.id);
            }}
            onPointerEnter={() => session.hover(row.id)}
            onPointerLeave={() => session.hover(0)}
            onClick={(e) => onRowClick(e, row.id)}
            onDoubleClick={() => setRenaming(row.id)}
            onContextMenu={menu(() => rowMenu(row.id))}
          >
            <span
              className="ink-twisty"
              onClick={(e) => {
                e.stopPropagation();
                const next = new Set(collapsed);
                next.has(row.id) ? next.delete(row.id) : next.add(row.id);
                setCollapsed(next);
              }}
            >
              {row.hasChildren && (
                <Icon
                  name={collapsed.has(row.id) ? "chevronRight" : "chevronDown"}
                  size={12}
                />
              )}
            </span>
            <span className="ink-row-icon">
              <Icon name={row.icon} size={13} />
            </span>
            {renaming === row.id
              ? (
                <input
                  autoFocus
                  defaultValue={session.names.get(row.id) ?? ""}
                  placeholder={row.name}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      (e.target as HTMLInputElement).blur();
                    }
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={(e) => {
                    setRenaming(null);
                    session.rename(row.id, e.target.value);
                  }}
                />
              )
              : <span className="ink-row-label">{row.name}</span>}
            {row.meta && <span className="ink-row-meta">{row.meta}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export { arrayEqual };
