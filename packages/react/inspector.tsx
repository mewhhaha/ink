/**
 * A schema-driven inspector: the selected entity's components (or the
 * world's resources when nothing is selected), with an editor per field.
 * Edits apply to every selected entity that has the component, only for the
 * fields that changed, so a running game keeps driving the others.
 */
import { useRef, useState } from "react";
import type { Transaction } from "@ink/core";
import {
  defaultRecord,
  type RecordSchema,
  type RecordValue,
  type Value,
} from "@ink/schema";
import {
  jsonEqual,
  useSelection,
  useSession,
  useSessionValue,
} from "./context.tsx";
import { FieldRows } from "./fields.tsx";
import { componentIcon, Icon } from "./icons.tsx";
import { type MenuItem, useDropdown, useMenu } from "./menu.tsx";

function changedKeys(before: RecordValue, after: RecordValue): string[] {
  return Object.keys(after).filter((k) =>
    JSON.stringify(before[k]) !== JSON.stringify(after[k])
  );
}

/** Apply field edits as live previews and commit them as one undo step. */
function useEditor() {
  const session = useSession();
  const tx = useRef<Transaction | null>(null);
  const apply = (
    label: string,
    recipe: Parameters<Transaction["update"]>[0],
    final: boolean,
  ) => {
    if (!final) {
      tx.current ??= session.begin(label);
      tx.current.update(recipe);
    } else if (tx.current) {
      tx.current.update(recipe);
      tx.current.commit();
      tx.current = null;
    } else {
      session.edit(label, recipe);
    }
  };
  return (
    label: string,
    recipe: Parameters<Transaction["update"]>[0],
    final: boolean,
  ) =>
    session.profiler.measure(
      "tuning",
      label,
      () => apply(label, recipe, final),
    );
}

export function Inspector(props: {
  /** Components hidden from the inspector and the add menu. */
  hide?: string[];
  /** Extra sections after the components, e.g. game-specific tools. */
  children?: React.ReactNode;
}) {
  const selection = useSelection();
  const id = selection[0];
  if (id === undefined) return <ResourcesInspector />;
  return (
    <div className="ink-inspector">
      <EntityInspector
        id={id}
        others={selection.slice(1)}
        hide={props.hide ?? []}
      />
      {props.children}
    </div>
  );
}

function EntityInspector(
  { id, others, hide }: {
    id: number;
    others: readonly number[];
    hide: string[];
  },
) {
  const session = useSession();
  const entity = useSessionValue(
    (s) => s.world.entities.find((e) => e.id === id),
    jsonEqual,
  );
  const name = useSessionValue((s) => s.names.get(id) ?? "");
  const label = useSessionValue((s) => s.nameOf(id));
  const live = useSessionValue((s) => s.mode === "play");
  const schema = useSessionValue((s) => s.schema);
  const dropdown = useDropdown();
  const edit = useEditor();
  if (!entity) return <div className="ink-empty">Entity #{id} is gone.</div>;
  const present = schema.components.filter((c) =>
    entity.components[c.name] && !hide.includes(c.name)
  );
  const missing = schema.components.filter((c) =>
    !entity.components[c.name] && !hide.includes(c.name) && !c.hidden
  );
  const targets = [id, ...others];

  const addMenu = (): MenuItem[] => {
    const groups = new Map<string, RecordSchema[]>();
    for (const c of missing) {
      const key = c.category ?? "Game";
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    return [...groups].flatMap(([category, components]) => [
      { heading: category } as MenuItem,
      ...components.map((c): MenuItem => ({
        label: c.name.replace(/_/g, " "),
        icon: componentIcon(c.name, c.icon),
        run: () =>
          session.edit(`Add ${c.name}`, (world) => {
            for (const target of targets) {
              const e = world.entities.find((x) => x.id === target);
              if (e && !e.components[c.name]) {
                e.components[c.name] = defaultRecord(c);
              }
            }
          }),
      })),
    ]);
  };

  return (
    <>
      <div className="ink-inspector-head">
        <Icon name="entity" size={16} style={{ color: "var(--ink-muted)" }} />
        <input
          key={id}
          defaultValue={name}
          placeholder={label}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => {
            if (e.target.value !== name) session.rename(id, e.target.value);
          }}
        />
        {others.length > 0 && <span className="ink-chip">+{others.length}
        </span>}
        <span
          className="ink-chip"
          title={live ? "Editing the running game" : "Editing the scene"}
          style={live ? { color: "var(--ink-play)" } : undefined}
        >
          {live ? "live" : `#${id}`}
        </span>
      </div>
      {present.map((component) => (
        <ComponentSection
          key={component.name}
          record={component}
          value={entity.components[component.name]}
          onChange={(value, final) => {
            const keys = changedKeys(entity.components[component.name], value);
            if (keys.length === 0 && !final) return;
            edit(`Edit ${component.name}`, (world) => {
              for (const target of targets) {
                const e = world.entities.find((x) => x.id === target);
                const current = e?.components[component.name];
                if (!current) continue;
                for (const key of keys) {
                  current[key] = structuredClone(value[key]);
                }
              }
            }, final);
          }}
          menu={[
            {
              label: "Reset to defaults",
              icon: "undo",
              run: () =>
                session.edit(`Reset ${component.name}`, (world) => {
                  for (const target of targets) {
                    const e = world.entities.find((x) => x.id === target);
                    if (e?.components[component.name]) {
                      e.components[component.name] = defaultRecord(component);
                    }
                  }
                }),
            },
            {
              label: "Copy as JSON",
              icon: "copy",
              run: () =>
                navigator.clipboard.writeText(
                  JSON.stringify(entity.components[component.name], null, 2),
                ),
            },
            { separator: true },
            {
              label: "Remove component",
              icon: "trash",
              danger: true,
              run: () =>
                session.edit(`Remove ${component.name}`, (world) => {
                  for (const target of targets) {
                    const e = world.entities.find((x) => x.id === target);
                    if (e) delete e.components[component.name];
                  }
                }),
            },
          ]}
        />
      ))}
      {missing.length > 0 && (
        <div style={{ padding: "10px" }}>
          <button
            type="button"
            className="ink-button"
            data-variant="outline"
            style={{ width: "100%" }}
            onClick={(e) => dropdown(e.currentTarget, addMenu())}
          >
            <Icon name="plus" /> Add component
          </button>
        </div>
      )}
    </>
  );
}

export function ComponentSection(props: {
  record: RecordSchema;
  value: RecordValue;
  onChange(value: RecordValue, final: boolean): void;
  menu?: MenuItem[];
  readonly?: boolean;
}) {
  const { record, value } = props;
  const [open, setOpen] = useState(true);
  const menu = useMenu();
  return (
    <section className="ink-section">
      <div
        className="ink-section-head"
        onClick={() => setOpen(!open)}
        onContextMenu={props.menu ? menu(props.menu) : undefined}
      >
        <Icon
          name={open ? "chevronDown" : "chevronRight"}
          size={12}
          style={{ color: "var(--ink-faint)" }}
        />
        <Icon
          name={componentIcon(record.name, record.icon)}
          size={13}
          style={{ color: "var(--ink-accent)" }}
        />
        <span>{record.name.replace(/_/g, " ")}</span>
        {props.menu && (
          <span className="ink-panel-actions">
            <button
              type="button"
              className="ink-button"
              data-icon-only="true"
              title="More"
              onClick={(e) => menu(props.menu!)(e)}
            >
              <Icon name="settings" size={12} />
            </button>
          </span>
        )}
      </div>
      {open && (
        <div className="ink-section-body">
          {record.description && (
            <div className="ink-section-description">{record.description}</div>
          )}
          {record.fields.length === 0
            ? (
              <div className="ink-section-description">
                A tag with no fields.
              </div>
            )
            : (
              <FieldRows
                fields={record.fields}
                value={value as Record<string, Value>}
                readonly={props.readonly}
                onChange={(next, final) =>
                  props.onChange(next as RecordValue, final)}
              />
            )}
        </div>
      )}
    </section>
  );
}

function ResourcesInspector() {
  const schema = useSessionValue((s) => s.schema);
  const resources = useSessionValue((s) => s.world.resources, jsonEqual);
  const tick = useSessionValue((s) => s.tick);
  const edit = useEditor();
  if (schema.resources.length === 0) {
    return <div className="ink-empty">Select an entity to inspect it.</div>;
  }
  return (
    <div className="ink-inspector">
      <div className="ink-inspector-head">
        <Icon name="layers" size={16} style={{ color: "var(--ink-muted)" }} />
        <span className="ink-panel-title" style={{ flex: 1 }}>World</span>
        <span className="ink-chip">tick {tick}</span>
      </div>
      {schema.resources.map((resource) => (
        <ComponentSection
          key={resource.name}
          record={resource}
          value={resources[resource.name]}
          onChange={(value, final) => {
            const keys = changedKeys(resources[resource.name], value);
            edit(`Edit ${resource.name}`, (world) => {
              for (const key of keys) {
                world.resources[resource.name][key] = structuredClone(
                  value[key],
                );
              }
            }, final);
          }}
        />
      ))}
    </div>
  );
}
