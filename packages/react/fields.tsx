/**
 * Editors for schema fields. Each takes the normalized schema node, its value
 * and `onChange(value, final)`: `final` is false while dragging or typing, so
 * an inspector can show changes live and record one undo step at the end.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Node, Value } from "@ink/schema";
import { defaultValue } from "@ink/schema";
import { type Quat, quat, type Vec3 } from "@ink/geometry";
import { Icon } from "./icons.tsx";
import { useSessionValue } from "./context.tsx";

export interface FieldProps<V = Value> {
  node: Node;
  value: V;
  onChange(value: V, final: boolean): void;
  readonly?: boolean;
}

export function formatNumber(value: number, integer = false): string {
  if (integer) return String(Math.round(value));
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** A number you can drag horizontally to scrub or click to type. */
export function NumberInput(props: {
  value: number;
  onChange(value: number, final: boolean): void;
  step?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  unit?: string;
  axis?: { label: string; color: string };
  readonly?: boolean;
}) {
  const { value, onChange, integer, unit, axis, readonly } = props;
  const step = props.step ?? (integer ? 1 : 0.01);
  const [text, setText] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<
    { x: number; start: number; moved: boolean; value: number } | null
  >(null);
  const clamp = (v: number) => {
    let next = Math.min(
      props.max ?? Infinity,
      Math.max(props.min ?? -Infinity, v),
    );
    if (integer) next = Math.round(next);
    return next;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (
      readonly || document.activeElement === input.current || event.button !== 0
    ) return;
    event.preventDefault();
    (event.target as Element).setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, start: value, moved: false, value };
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const scale = event.shiftKey
      ? 0.1
      : event.ctrlKey || event.metaKey
      ? 10
      : 1;
    // Pixel-to-value rate: one step per pixel, at least a thousandth of the value.
    const rate = Math.max(step, Math.abs(d.start) * 0.002) * scale;
    let next = clamp(d.start + dx * rate);
    if (!integer && step >= 0.01) {
      next = Math.round(next / (step * scale)) * (step * scale);
    }
    d.value = next;
    onChange(next, false);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) onChange(d.value, true);
    else {
      input.current?.focus();
      input.current?.select();
    }
  };
  const commit = () => {
    if (text === null) return;
    const parsed = evaluate(text);
    setText(null);
    if (parsed !== null && Number.isFinite(parsed)) {
      onChange(clamp(parsed), true);
    }
  };

  const ranged = props.min !== undefined && props.max !== undefined;
  return (
    <div className="ink-number" style={{ position: "relative" }}>
      {ranged && (
        <span
          className="ink-number-fill"
          style={{
            width: `${
              ((value - props.min!) / (props.max! - props.min!)) * 100
            }%`,
          }}
        />
      )}
      {axis && (
        <span
          className="ink-number-axis"
          style={{ background: axis.color }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {axis.label}
        </span>
      )}
      <input
        ref={input}
        value={text ?? formatNumber(value, integer)}
        readOnly={readonly}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onFocus={() => setText(formatNumber(value, integer))}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const delta = (e.key === "ArrowUp" ? 1 : -1) * step *
              (e.shiftKey ? 10 : 1);
            const next = clamp(value + delta);
            setText(formatNumber(next, integer));
            onChange(next, true);
          }
          e.stopPropagation();
        }}
      />
      {unit && <span className="ink-number-unit">{unit}</span>}
    </div>
  );
}

/** Arithmetic in number fields: "2*pi", "10/3", "1.5+0.25". */
function evaluate(text: string): number | null {
  const cleaned = text.replace(/pi/gi, String(Math.PI)).replace(/\s+/g, "");
  if (!/^[-+*/().\deE]+$/.test(cleaned)) return null;
  try {
    const result = new Function(`return (${cleaned});`)();
    return typeof result === "number" ? result : null;
  } catch {
    return null;
  }
}

const axes = [
  { label: "X", color: "var(--ink-x)" },
  { label: "Y", color: "var(--ink-y)" },
  { label: "Z", color: "var(--ink-z)" },
  { label: "W", color: "var(--ink-muted)" },
];

export function VectorInput(props: {
  value: number[];
  onChange(value: number[], final: boolean): void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  readonly?: boolean;
  labels?: string[];
}) {
  return (
    <div className="ink-vector">
      {props.value.map((component, i) => (
        <NumberInput
          key={i}
          value={component}
          step={props.step}
          min={props.min}
          max={props.max}
          readonly={props.readonly}
          axis={props.labels
            ? { label: props.labels[i], color: "var(--ink-border-strong)" }
            : axes[i]}
          onChange={(v, final) => {
            const next = [...props.value];
            next[i] = v;
            props.onChange(next, final);
          }}
        />
      ))}
    </div>
  );
}

export function quatToEuler(q: number[]): number[] {
  return quat.toEuler(q as Quat);
}

export function eulerToQuat(euler: number[]): number[] {
  return quat.fromEuler(euler as Vec3);
}

function QuatInput({ value, onChange, readonly }: FieldProps<number[]>) {
  // Keep the user's Euler angles while editing so gimbal flips do not jump.
  const [euler, setEuler] = useState(() => quatToEuler(value));
  const last = useRef(value);
  useEffect(() => {
    if (value.some((v, i) => Math.abs(v - last.current[i]) > 1e-5)) {
      setEuler(quatToEuler(value));
      last.current = value;
    }
  }, [value]);
  return (
    <VectorInput
      value={euler}
      step={1}
      unit="°"
      readonly={readonly}
      onChange={(next, final) => {
        setEuler(next);
        const q = eulerToQuat(next);
        last.current = q;
        onChange(q, final);
      }}
    />
  );
}

const toHex = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
const fromHex = (hex: string, i: number) =>
  parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;

/** sRGB RGBA, 0..1 per channel. */
export function ColorInput(
  { value, onChange, readonly }: FieldProps<number[]>,
) {
  const hex = `#${toHex(value[0])}${toHex(value[1])}${toHex(value[2])}`;
  return (
    <div className="ink-color">
      <label className="ink-swatch" title={hex}>
        <span style={{ background: hex, opacity: value[3] }} />
        <input
          type="color"
          value={hex}
          disabled={readonly}
          onChange={(e) =>
            onChange([
              fromHex(e.target.value, 0),
              fromHex(e.target.value, 1),
              fromHex(e.target.value, 2),
              value[3],
            ], false)}
          onBlur={(e) =>
            onChange([
              fromHex(e.target.value, 0),
              fromHex(e.target.value, 1),
              fromHex(e.target.value, 2),
              value[3],
            ], true)}
        />
      </label>
      <NumberInput
        value={value[3]}
        min={0}
        max={1}
        step={0.01}
        readonly={readonly}
        axis={{ label: "A", color: "var(--ink-border-strong)" }}
        onChange={(a, final) =>
          onChange([value[0], value[1], value[2], a], final)}
      />
    </div>
  );
}

export function Checkbox(
  { checked, onChange, disabled }: {
    checked: boolean;
    onChange(value: boolean): void;
    disabled?: boolean;
  },
) {
  return (
    <button
      type="button"
      role="checkbox"
      className="ink-check"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {checked && <Icon name="check" size={12} strokeWidth={3} />}
    </button>
  );
}

function AssetSelect({ node, value, onChange, readonly }: FieldProps<number>) {
  const kind = (node.field as { asset: string }).asset;
  const paths = useSessionValue((s) => s.catalog.assets[kind] ?? []);
  return (
    <select
      className="ink-select"
      value={value}
      disabled={readonly}
      onChange={(e) => onChange(Number(e.target.value), true)}
    >
      <option value={0}>None</option>
      {paths.map((path, i) => (
        <option key={path} value={i + 1}>
          {path.replace(/^builtin:/, "◆ ")}
        </option>
      ))}
    </select>
  );
}

function EntitySelect({ value, onChange, readonly }: FieldProps<number>) {
  const options = useSessionValue(
    (s) => s.world.entities.map((e) => [e.id, s.nameOf(e.id)] as const),
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );
  return (
    <select
      className="ink-select"
      value={value}
      disabled={readonly}
      onChange={(e) => onChange(Number(e.target.value), true)}
    >
      <option value={0}>None</option>
      {options.map(([id, name]) => (
        <option key={id} value={id}>{name} (#{id})</option>
      ))}
    </select>
  );
}

function MessageSelect({ value, onChange, readonly }: FieldProps<number>) {
  const messages = useSessionValue((s) => s.schema.messages);
  return (
    <select
      className="ink-select"
      value={value}
      disabled={readonly}
      onChange={(e) => onChange(Number(e.target.value), true)}
    >
      <option value={0}>None</option>
      {messages.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );
}

/** The editor for any schema node (without its label). */
export function FieldEditor(props: FieldProps) {
  const { node, value, onChange, readonly } = props;
  const meta = node.field as {
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
  };
  switch (node.kind) {
    case "f32":
      return (
        <NumberInput
          value={value as number}
          onChange={onChange}
          readonly={readonly}
          {...meta}
        />
      );
    case "u32":
      return (
        <NumberInput
          value={value as number}
          onChange={onChange}
          readonly={readonly}
          integer
          min={meta.min ?? 0}
          max={meta.max}
          step={meta.step ?? 1}
          unit={meta.unit}
        />
      );
    case "bool":
      return (
        <Checkbox
          checked={value as boolean}
          onChange={(v) => onChange(v, true)}
          disabled={readonly}
        />
      );
    case "vec2":
    case "vec3":
    case "vec4":
      return (
        <VectorInput
          value={value as number[]}
          onChange={onChange}
          readonly={readonly}
          step={meta.step ?? 0.1}
          min={meta.min}
          max={meta.max}
        />
      );
    case "quat":
      return <QuatInput {...(props as FieldProps<number[]>)} />;
    case "color":
      return <ColorInput {...(props as FieldProps<number[]>)} />;
    case "enum":
      return (
        <select
          className="ink-select"
          value={value as string}
          disabled={readonly}
          onChange={(e) => onChange(e.target.value, true)}
        >
          {node.values.map((v) => (
            <option key={v} value={v}>{v.replace(/_/g, " ")}</option>
          ))}
        </select>
      );
    case "asset":
      return <AssetSelect {...(props as FieldProps<number>)} />;
    case "entity":
      return <EntitySelect {...(props as FieldProps<number>)} />;
    case "message":
      return <MessageSelect {...(props as FieldProps<number>)} />;
    case "struct":
      return null;
    case "list":
      return null;
  }
}

const humanize = (name: string) => name.replace(/_/g, " ");

/** Label + editor rows for named fields, recursing into structs and lists. */
export function FieldRows(props: {
  fields: { name: string; node: Node }[];
  value: Record<string, Value>;
  onChange(value: Record<string, Value>, final: boolean): void;
  readonly?: boolean;
}): ReactNode {
  let group: string | undefined;
  return props.fields.map(({ name, node }) => {
    const meta = node.field;
    if (meta.hidden) return null;
    const value = props.value[name];
    const set = (next: Value, final: boolean) =>
      props.onChange({ ...props.value, [name]: next }, final);
    const heading = meta.group && meta.group !== group
      ? (
        <div key={`${name}-group`} className="ink-field-group">
          {meta.group}
        </div>
      )
      : null;
    group = meta.group ?? group;
    const label = (
      <span className="ink-field-label" title={meta.description ?? name}>
        {meta.label ?? humanize(name)}
      </span>
    );
    if (node.kind === "struct") {
      return [
        heading,
        <div key={name} className="ink-field-group">
          {meta.label ?? humanize(name)}
        </div>,
        <FieldRows
          key={`${name}-rows`}
          fields={node.fields}
          value={value as Record<string, Value>}
          onChange={set as (v: Record<string, Value>, f: boolean) => void}
          readonly={props.readonly || meta.readonly}
        />,
      ];
    }
    if (node.kind === "list") {
      return [
        heading,
        <ListField
          key={name}
          name={name}
          node={node}
          value={value as Value[]}
          onChange={set}
          readonly={props.readonly || meta.readonly}
        />,
      ];
    }
    return [
      heading,
      <span key={`${name}-label`} style={{ display: "contents" }}>
        {label}
      </span>,
      <FieldEditor
        key={name}
        node={node}
        value={value}
        onChange={set}
        readonly={props.readonly || meta.readonly}
      />,
    ];
  });
}

function ListField(props: {
  name: string;
  node: Node & { kind: "list" };
  value: Value[];
  onChange(value: Value[], final: boolean): void;
  readonly?: boolean;
}) {
  const { node, value, onChange, readonly } = props;
  const [open, setOpen] = useState(value.length <= 4);
  const element = node.element;
  const max = node.field.max ?? Infinity;
  return (
    <div className="ink-list-field">
      <div className="ink-list-head">
        <button
          type="button"
          className="ink-button"
          data-icon-only="true"
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        </button>
        <span>
          {props.node.field.label ?? humanize(props.name)} · {value.length}
        </span>
        <span className="ink-bar-spacer" />
        {!readonly && value.length < max && (
          <button
            type="button"
            className="ink-button"
            data-icon-only="true"
            title="Add"
            onClick={() => onChange([...value, defaultValue(element)], true)}
          >
            <Icon name="plus" size={12} />
          </button>
        )}
      </div>
      {open && value.map((item, i) => (
        <div key={i} className="ink-list-item">
          <div className="ink-list-head">
            <span>#{i}</span>
            <span className="ink-bar-spacer" />
            {!readonly && (
              <button
                type="button"
                className="ink-button"
                data-variant="danger"
                data-icon-only="true"
                title="Remove"
                onClick={() => onChange(value.filter((_, j) => j !== i), true)}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
          {element.kind === "struct"
            ? (
              <FieldRows
                fields={element.fields}
                value={item as Record<string, Value>}
                readonly={readonly}
                onChange={(next, final) =>
                  onChange(value.map((v, j) => (j === i ? next : v)), final)}
              />
            )
            : (
              <div className="ink-field-wide">
                <FieldEditor
                  node={element}
                  value={item}
                  readonly={readonly}
                  onChange={(next, final) =>
                    onChange(value.map((v, j) => (j === i ? next : v)), final)}
                />
              </div>
            )}
        </div>
      ))}
    </div>
  );
}
