/**
 * The entity tree: selection, rename, drag to reparent or reorder, context
 * menu, search. Entities created by the running game show up while playing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { componentNames, type EntityModel } from "@ink/schema";
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
  hasChildren: boolean;
  meta?: string;
}

/** Icon for an entity from its most telling component. Takes the components
 * themselves or just their names, which spares large packed worlds a decode. */
export function entityIcon(
  components: Record<string, unknown> | readonly string[],
  icons: Record<string, string | undefined> = {},
  lightKind?: () => string | undefined,
): string {
  const names = Array.isArray(components)
    ? components as readonly string[]
    : Object.keys(components);
  const has = (name: string) => names.includes(name);
  for (const name of ["camera", "light", "brush", "mesh"]) {
    if (name === "light" && has("light")) {
      const kind = Array.isArray(components)
        ? lightKind?.()
        : (components as Record<string, { kind?: string }>).light?.kind;
      return kind === "point" ? "bulb" : kind === "spot" ? "spotlight" : "sun";
    }
    if (has(name)) return componentIcon(name);
  }
  const custom = names.find((c) => c !== "transform");
  return custom ? componentIcon(custom, icons[custom]) : "entity";
}

const ROW_OVERSCAN = 12;

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

  // Only structure and names matter here, not every field of every step; the
  // structure is the same object until an entity appears, moves or is renamed.
  const structure = useSessionValue((s) => s.structure);
  const names = useSessionValue((s) => s.names);
  const schemaNames = useSessionValue((s) => s.schema);

  const rows = useMemo(() => {
    const kept = filter
      ? structure.rows.filter((r) => {
        const entity = session.entity(r.id);
        return entity ? filter(entity) : false;
      })
      : structure.rows;
    const children = new Map<number, typeof kept[number][]>();
    const ids = new Set(kept.map((e) => e.id));
    for (const e of kept) {
      const parent = ids.has(e.parent) ? e.parent : 0;
      const list = children.get(parent);
      if (list) list.push(e);
      else children.set(parent, [e]);
    }
    const label = new Map<number, string>();
    const nameOf = (id: number) => {
      let name = label.get(id);
      if (name === undefined) label.set(id, name = session.nameOf(id));
      return name;
    };
    const q = query.trim().toLowerCase();
    const matched = new Map<number, boolean>();
    const matches = (id: number): boolean => {
      let known = matched.get(id);
      if (known === undefined) {
        known = nameOf(id).toLowerCase().includes(q) ||
          (children.get(id) ?? []).some((c) => matches(c.id));
        matched.set(id, known);
      }
      return known;
    };
    const out: Row[] = [];
    const walk = (parent: number, depth: number) => {
      for (const e of children.get(parent) ?? []) {
        if (q && !matches(e.id)) continue;
        const kids = children.get(e.id);
        out.push({
          id: e.id,
          depth,
          name: nameOf(e.id),
          hasChildren: kids !== undefined,
          meta: names.has(e.id) ? undefined : `#${e.id}`,
        });
        if (!collapsed.has(e.id) || q) walk(e.id, depth + 1);
      }
    };
    walk(0, 0);
    return out;
    // `names` and the schema's names change what a row says.
  }, [structure, names, schemaNames, collapsed, query, filter, session]);

  const icons = useMemo(
    () =>
      Object.fromEntries(schemaNames.components.map((c) => [c.name, c.icon])),
    [schemaNames],
  );
  const selected = useMemo(() => new Set(selection), [selection]);

  // Only the rows in view are rendered, so a world of thousands stays light.
  const tree = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  const [rowHeight, setRowHeight] = useState(24);
  useEffect(() => {
    const element = tree.current;
    if (!element) return;
    const measure = () => {
      const px = parseFloat(
        getComputedStyle(element).getPropertyValue("--ink-row"),
      );
      if (px > 0) setRowHeight(px);
      setView({ top: element.scrollTop, height: element.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const first = Math.max(
    0,
    Math.floor(view.top / rowHeight) - ROW_OVERSCAN,
  );
  const last = Math.min(
    rows.length,
    Math.ceil((view.top + view.height) / rowHeight) + ROW_OVERSCAN,
  );
  const visible = rows.slice(first, last);

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

  const rowIcon = (id: number) => {
    const entity = session.entity(id);
    if (!entity) return "entity";
    return entityIcon(
      componentNames(entity),
      icons,
      () => (entity.components.light as { kind?: string } | undefined)?.kind,
    );
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
        ref={tree}
        tabIndex={0}
        style={{ flex: 1, overflow: "auto" }}
        onScroll={(e) =>
          setView({
            top: e.currentTarget.scrollTop,
            height: e.currentTarget.clientHeight,
          })}
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
        {first > 0 && <div style={{ height: first * rowHeight }} />}
        {visible.map((row) => (
          <div
            key={row.id}
            className="ink-row"
            aria-selected={selected.has(row.id)}
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
                const at = structure.index.get(row.id);
                const parent = at === undefined ? 0 : structure.rows[at].parent;
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
              <Icon name={rowIcon(row.id)} size={13} />
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
        {last < rows.length && (
          <div style={{ height: (rows.length - last) * rowHeight }} />
        )}
      </div>
    </div>
  );
}

export { arrayEqual };
