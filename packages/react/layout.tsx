/** Resizable splits and panels. Sizes persist with the UI state. */
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { useInk, useUi } from "./context.tsx";

export interface PaneProps {
  /** Initial size in pixels; omit for a flexible pane. */
  size?: number;
  min?: number;
  max?: number;
  children?: ReactNode;
}

/** A child of `<Split>`. */
export function Pane(props: PaneProps) {
  return <>{props.children}</>;
}

export function Split(
  props: { id: string; direction?: "row" | "column"; children: ReactNode },
) {
  const ink = useInk();
  const direction = props.direction ?? "row";
  const sizes = useUi((u) => u.sizes);
  const panes = Children.toArray(props.children).filter(
    isValidElement,
  ) as ReactElement<PaneProps>[];
  const [dragging, setDragging] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const key = (i: number) => `${props.id}:${i}`;
  const sizeOf = (i: number) => sizes[key(i)] ?? panes[i].props.size;

  const startDrag = (gutter: number, event: React.PointerEvent) => {
    // The gutter sits between panes `gutter` and `gutter + 1`; resize the fixed one.
    const before = panes[gutter].props.size !== undefined;
    const index = before ? gutter : gutter + 1;
    const pane = panes[index];
    const start = direction === "row" ? event.clientX : event.clientY;
    const initial = sizeOf(index) ?? 200;
    setDragging(gutter);
    (event.target as Element).setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const delta = (direction === "row" ? e.clientX : e.clientY) - start;
      const next = Math.min(
        pane.props.max ?? 2000,
        Math.max(pane.props.min ?? 120, initial + (before ? delta : -delta)),
      );
      ink.ui.set((u) => ({
        sizes: { ...u.sizes, [key(index)]: Math.round(next) },
      }));
    };
    const up = () => {
      setDragging(null);
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };

  const items: ReactNode[] = [];
  panes.forEach((pane, i) => {
    if (i > 0) {
      items.push(
        <div
          key={`gutter-${i}`}
          className="ink-gutter"
          data-dragging={dragging === i - 1}
          onPointerDown={(e) => startDrag(i - 1, e)}
        />,
      );
    }
    const size = sizeOf(i);
    items.push(
      <div
        key={`pane-${i}`}
        className="ink-pane"
        data-flex={size === undefined}
        style={size === undefined ? undefined : { flex: `0 0 ${size}px` }}
      >
        {pane.props.children}
      </div>,
    );
  });
  return (
    <div ref={ref} className="ink-split" data-direction={direction}>
      {items}
    </div>
  );
}

export interface Tab {
  id: string;
  label: string;
  content: ReactNode;
  badge?: ReactNode;
}

export function Panel(props: {
  title?: string;
  tabs?: Tab[];
  actions?: ReactNode;
  children?: ReactNode;
  /** Remember the selected tab under this id. */
  id?: string;
  style?: React.CSSProperties;
}) {
  const storageKey = props.id
    ? `ink:tab:${location.pathname}:${props.id}`
    : null;
  const [tab, setTab] = useState(() =>
    (storageKey && localStorage.getItem(storageKey)) || props.tabs?.[0]?.id
  );
  const active = props.tabs?.find((t) => t.id === tab) ?? props.tabs?.[0];
  return (
    <section className="ink-panel" style={props.style}>
      {(props.title || props.tabs || props.actions) && (
        <header className="ink-panel-header">
          {props.tabs
            ? (
              <div className="ink-panel-tabs" role="tablist">
                {props.tabs.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    className="ink-tab"
                    role="tab"
                    aria-selected={t.id === active?.id}
                    onClick={() => {
                      setTab(t.id);
                      if (storageKey) localStorage.setItem(storageKey, t.id);
                    }}
                  >
                    {t.label} {t.badge}
                  </button>
                ))}
              </div>
            )
            : <span className="ink-panel-title">{props.title}</span>}
          {props.actions && (
            <div className="ink-panel-actions">{props.actions}</div>
          )}
        </header>
      )}
      <div className="ink-panel-body">
        {active ? active.content : props.children}
      </div>
    </section>
  );
}

/** The area under the top bar where splits go. */
export function Workspace({ children }: { children: ReactNode }) {
  return <div className="ink-workspace">{children}</div>;
}
