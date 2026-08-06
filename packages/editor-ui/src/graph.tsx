import { type ReactNode, useId } from "react";
import type { EditorStyle, Interaction } from "./controls.tsx";

export interface TimelineRulerProps {
  readonly label: string;
  readonly duration_seconds: number;
  readonly playhead_seconds: number;
  readonly tick_interval_seconds?: number;
  readonly markers?: readonly number[];
}

export function TimelineRuler({
  label,
  duration_seconds,
  playhead_seconds,
  tick_interval_seconds = 1,
  markers = [],
}: TimelineRulerProps) {
  const ticks = timeline_ticks(duration_seconds, tick_interval_seconds);
  const playhead = bounded_fraction(playhead_seconds, duration_seconds);
  return (
    <figure className="ink-timeline-ruler" aria-label={label}>
      <figcaption className="ink-visually-hidden">
        {label}, {duration_seconds} seconds
      </figcaption>
      <ol>
        {ticks.map((tick) => (
          <li
            key={tick}
            style={{
              "--ink-timeline-position": tick / duration_seconds,
            } as EditorStyle}
          >
            <span>{tick}s</span>
          </li>
        ))}
      </ol>
      {markers.map((marker, index) => (
        <span
          key={`${marker}-${index}`}
          className="ink-timeline-marker"
          title={`${marker} seconds`}
          style={{
            "--ink-timeline-position": bounded_fraction(
              marker,
              duration_seconds,
            ),
          } as EditorStyle}
        />
      ))}
      <span
        className="ink-timeline-playhead"
        title={`Playhead ${playhead_seconds} seconds`}
        style={{ "--ink-timeline-position": playhead } as EditorStyle}
      />
    </figure>
  );
}

export function timeline_ticks(
  duration_seconds: number,
  interval_seconds: number,
): readonly number[] {
  if (!Number.isFinite(duration_seconds) || duration_seconds <= 0) {
    throw new Error(
      `timeline duration ${
        String(duration_seconds)
      } must be finite and positive`,
    );
  }
  if (!Number.isFinite(interval_seconds) || interval_seconds <= 0) {
    throw new Error(
      `timeline interval ${
        String(interval_seconds)
      } must be finite and positive`,
    );
  }
  const ticks: number[] = [];
  for (let tick = 0; tick <= duration_seconds; tick += interval_seconds) {
    ticks.push(Number(tick.toFixed(6)));
  }
  if (ticks.at(-1) !== duration_seconds) ticks.push(duration_seconds);
  return ticks;
}

export interface CurveEditorShellProps {
  readonly label: string;
  readonly children?: ReactNode;
}

export function CurveEditorShell({ label, children }: CurveEditorShellProps) {
  const title_id = useId();
  return (
    <figure className="ink-curve-editor">
      <svg viewBox="0 0 320 160" role="img" aria-labelledby={title_id}>
        <title id={title_id}>{label}</title>
        <path
          className="ink-curve-grid"
          d="M0 40H320M0 80H320M0 120H320M80 0V160M160 0V160M240 0V160"
        />
        {children ?? (
          <path
            className="ink-curve"
            d="M0 140 C80 140 100 20 180 40 S260 120 320 20"
          />
        )}
      </svg>
    </figure>
  );
}

export interface NodeSocketProps {
  readonly label: string;
  readonly direction: "input" | "output";
  readonly socket_type: string;
  readonly connections: number;
  readonly onConnect?: () => void;
  readonly interaction?: Interaction;
}

export function NodeSocket({
  label,
  direction,
  socket_type,
  connections,
  onConnect,
  interaction = "enabled",
}: NodeSocketProps) {
  return (
    <button
      type="button"
      className="ink-node-socket"
      data-direction={direction}
      data-socket-type={socket_type}
      aria-label={`${label}, ${direction} ${socket_type}, ${connections} connections`}
      disabled={interaction === "disabled"}
      onClick={onConnect}
    >
      <span aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

export interface GraphNodeProps {
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly children: ReactNode;
  readonly selected?: "selected" | "unselected";
}

export function GraphNode({
  title,
  x,
  y,
  children,
  selected = "unselected",
}: GraphNodeProps) {
  const style: EditorStyle = {
    "--ink-node-x": `${x}px`,
    "--ink-node-y": `${y}px`,
  };
  return (
    <article className="ink-graph-node" data-selected={selected} style={style}>
      <header>{title}</header>
      <div>{children}</div>
    </article>
  );
}

export interface NodeGraphProps {
  readonly label: string;
  readonly children: ReactNode;
}

export function NodeGraph({ label, children }: NodeGraphProps) {
  return (
    <section className="ink-node-graph" aria-label={label}>{children}</section>
  );
}

function bounded_fraction(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value / maximum));
}
