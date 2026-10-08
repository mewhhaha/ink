/**
 * The Outputs and Inputs tabs of Object Properties. Outputs are the selected
 * entity's connections ("when <event> happens, send <input> to <target> after
 * <delay>"); Inputs lists the connections elsewhere that target it.
 */
import { useRef } from "react";
import {
  Checkbox,
  Icon,
  jsonEqual,
  NumberInput,
  useSelection,
  useSession,
  useSessionValue,
} from "@ink/react";
import type { Transaction } from "@ink/core";
import {
  type Connection,
  connectionsOf,
  css,
  defaultConnection,
  eventsFor,
  incoming,
  inputColor,
  inputsFor,
  type IoEvent,
  ioEvents,
  type IoInput,
  ioInputs,
  pretty,
} from "./io.ts";

function useSelected() {
  const selection = useSelection();
  const id = selection[0];
  const entity = useSessionValue(
    (s) => s.world.entities.find((e) => e.id === id),
    jsonEqual,
  );
  const name = useSessionValue((s) => (id === undefined ? "" : s.nameOf(id)));
  return { id, entity, name };
}

/** Entities that can be a target, with display names. */
function useTargets() {
  return useSessionValue(
    (s) =>
      s.world.entities.map((e) => ({
        id: e.id,
        name: s.nameOf(e.id),
        entity: e,
      })),
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );
}

function Grouped<T extends string>(
  props: {
    relevant: T[];
    all: readonly T[];
    value: T;
    onChange(value: T): void;
  },
) {
  const others = props.all.filter((v) => !props.relevant.includes(v));
  return (
    <select
      className="ink-select"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as T)}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {props.relevant.length > 0 && (
        <optgroup label="This entity">
          {props.relevant.map((v) => (
            <option key={v} value={v}>{pretty(v)}</option>
          ))}
        </optgroup>
      )}
      <optgroup label={props.relevant.length > 0 ? "Other" : "All"}>
        {others.map((v) => <option key={v} value={v}>{pretty(v)}</option>)}
      </optgroup>
    </select>
  );
}

export function OutputsPanel() {
  const session = useSession();
  const { id, entity, name } = useSelected();
  const targets = useTargets();
  const tx = useRef<Transaction | null>(null);
  if (id === undefined || !entity) {
    return (
      <div className="ink-empty">Select an entity to edit its outputs.</div>
    );
  }
  const connections = connectionsOf(entity);
  const hover = (target: number) => session.hover(target);

  const edit = (
    label: string,
    recipe: (list: Connection[]) => void,
    final = true,
  ) => {
    const apply = (
      world: Parameters<Parameters<typeof session.edit>[1]>[0],
    ) => {
      const e = world.entities.find((x) => x.id === id);
      if (!e) return;
      const outputs =
        (e.components.outputs ??= { connections: [] }) as unknown as {
          connections: Connection[];
        };
      recipe(outputs.connections);
    };
    if (!final) {
      tx.current ??= session.begin(label);
      tx.current.update(apply);
    } else if (tx.current) {
      tx.current.update(apply);
      tx.current.commit();
      tx.current = null;
    } else {
      session.edit(label, apply);
    }
  };
  const patch = (index: number, change: Partial<Connection>, final = true) =>
    edit("Edit output", (list) => {
      list[index] = { ...list[index], ...change };
    }, final);

  return (
    <div className="hammer-io">
      <div className="hammer-io-head">
        <Icon name="send" size={14} style={{ color: "var(--ink-accent)" }} />
        <span className="hammer-io-title">{name}</span>
        <span className="ink-chip">
          {connections.length} output{connections.length === 1 ? "" : "s"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="ink-button"
          data-variant="outline"
          onClick={() =>
            edit("Add output", (list) => list.push(defaultConnection(entity)))}
        >
          <Icon name="plus" /> Add
        </button>
      </div>
      {connections.length === 0 && (
        <div className="ink-empty">
          No outputs. <b>Add</b> one to wire an event on {name}{" "}
          to another entity's input.
        </div>
      )}
      {connections.map((connection, index) => {
        const target = targets.find((t) => t.id === connection.target);
        const color = css(inputColor(connection.input));
        return (
          <div
            key={index}
            className="hammer-conn"
            style={{ borderLeftColor: color }}
            onMouseEnter={() => hover(connection.target)}
            onMouseLeave={() => hover(0)}
          >
            <div className="hammer-conn-row">
              <span className="hammer-conn-label">When</span>
              <Grouped<IoEvent>
                relevant={eventsFor(entity)}
                all={ioEvents}
                value={connection.event}
                onChange={(event) => patch(index, { event })}
              />
              <button
                type="button"
                className="ink-button"
                data-icon-only="true"
                title="Delete output"
                onClick={() =>
                  edit("Delete output", (list) => void list.splice(index, 1))}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
            <div className="hammer-conn-row">
              <span className="hammer-conn-label">Send to</span>
              <select
                className="ink-select"
                value={connection.target}
                onChange={(e) =>
                  patch(index, { target: Number(e.target.value) })}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <option value={0}>(none)</option>
                {targets.filter((t) => t.id !== 0).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button
                type="button"
                className="ink-button"
                data-icon-only="true"
                title="Select target"
                disabled={!target}
                onClick={() => target && session.select([target.id])}
              >
                <Icon name="select" size={12} />
              </button>
            </div>
            <div className="hammer-conn-row">
              <span className="hammer-conn-label">Input</span>
              <Grouped<IoInput>
                relevant={inputsFor(target?.entity)}
                all={ioInputs}
                value={connection.input}
                onChange={(input) => patch(index, { input })}
              />
            </div>
            <div className="hammer-conn-row">
              <span className="hammer-conn-label">Delay</span>
              <div style={{ flex: 1 }}>
                <NumberInput
                  value={connection.delay}
                  min={0}
                  max={60}
                  step={0.1}
                  unit="s"
                  onChange={(delay, final) => patch(index, { delay }, final)}
                />
              </div>
              <label className="hammer-once" title="Fire only the first time">
                <Checkbox
                  checked={connection.once}
                  onChange={(once) => patch(index, { once })}
                />{" "}
                once
              </label>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function InputsPanel() {
  const session = useSession();
  const { id, entity, name } = useSelected();
  const rows = useSessionValue(
    (s) =>
      id === undefined ? [] : incoming(s.world, id).map((r) => ({
        ...r,
        sourceName: s.nameOf(r.source.id),
      })),
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );
  if (id === undefined || !entity) {
    return (
      <div className="ink-empty">
        Select an entity to see what sends it inputs.
      </div>
    );
  }
  return (
    <div className="hammer-io">
      <div className="hammer-io-head">
        <Icon name="entity" size={14} style={{ color: "var(--ink-accent)" }} />
        <span className="hammer-io-title">{name}</span>
        <span className="ink-chip">
          {rows.length} input{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      {rows.length === 0 && (
        <div className="ink-empty">Nothing is wired to {name} yet.</div>
      )}
      {rows.map(({ source, sourceName, connection, index }) => (
        <div
          key={`${source.id}:${index}`}
          className="hammer-conn hammer-conn-link"
          style={{ borderLeftColor: css(inputColor(connection.input)) }}
          onClick={() => session.select([source.id])}
          onMouseEnter={() => session.hover(source.id)}
          onMouseLeave={() => session.hover(0)}
          title={`Select ${sourceName}`}
        >
          <div className="hammer-conn-row">
            <b>{sourceName}</b>
            <span className="hammer-faint">{pretty(connection.event)}</span>
          </div>
          <div className="hammer-conn-row">
            <span className="hammer-faint">→</span>
            <b style={{ color: css(inputColor(connection.input)) }}>
              {pretty(connection.input)}
            </b>
            {connection.delay > 0 && (
              <span className="ink-chip">{connection.delay}s</span>
            )}
            {connection.once && <span className="ink-chip">once</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
