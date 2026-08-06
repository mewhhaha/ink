import { type KeyboardEvent, type ReactNode, useId } from "react";
import type { EditorStyle } from "./controls.tsx";

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
  readonly panel: ReactNode;
}

export interface EditorTabsProps {
  readonly label: string;
  readonly tabs: readonly TabDefinition[];
  readonly selected_id: string;
  readonly onSelect: (id: string) => void;
}

export function EditorTabs({
  label,
  tabs,
  selected_id,
  onSelect,
}: EditorTabsProps) {
  const prefix = useId();
  const selected = tabs.find((tab) => tab.id === selected_id) ?? tabs[0];
  const move_focus = (
    event: KeyboardEvent<HTMLDivElement>,
    direction: -1 | 1,
  ) => {
    const current = tabs.findIndex((tab) => tab.id === selected?.id);
    if (current < 0 || tabs.length === 0) return;
    event.preventDefault();
    const next = (current + direction + tabs.length) % tabs.length;
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="tab"]',
    )[next]?.focus();
    onSelect(tabs[next].id);
  };
  return (
    <section className="ink-tabs">
      <div
        className="ink-tab-list"
        role="tablist"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            move_focus(
              event,
              -1,
            );
          }
          if (
            event.key === "ArrowRight" || event.key === "ArrowDown"
          ) move_focus(event, 1);
        }}
      >
        {tabs.map((tab) => {
          const active = tab.id === selected?.id;
          return (
            <button
              key={tab.id}
              id={`${prefix}-${tab.id}-tab`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`${prefix}-${tab.id}-panel`}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {selected && (
        <div
          id={`${prefix}-${selected.id}-panel`}
          className="ink-tab-panel"
          role="tabpanel"
          aria-labelledby={`${prefix}-${selected.id}-tab`}
        >
          {selected.panel}
        </div>
      )}
    </section>
  );
}

export interface SplitPaneProps {
  readonly label: string;
  readonly first: ReactNode;
  readonly second: ReactNode;
  readonly ratio: number;
  readonly onRatioChange: (ratio: number) => void;
  readonly orientation?: "horizontal" | "vertical";
}

export function SplitPane({
  label,
  first,
  second,
  ratio,
  onRatioChange,
  orientation = "horizontal",
}: SplitPaneProps) {
  const bounded_ratio = Math.max(0.1, Math.min(0.9, ratio));
  const style: EditorStyle = { "--ink-split-ratio": bounded_ratio };
  return (
    <div
      className="ink-split-pane"
      data-orientation={orientation}
      style={style}
    >
      <div className="ink-split-panel">{first}</div>
      <input
        className="ink-split-resizer"
        type="range"
        aria-label={label}
        aria-orientation={orientation}
        min={10}
        max={90}
        value={bounded_ratio * 100}
        onChange={(event) =>
          onRatioChange(event.currentTarget.valueAsNumber / 100)}
      />
      <div className="ink-split-panel">{second}</div>
    </div>
  );
}

export interface ToolbarProps {
  readonly label: string;
  readonly children: ReactNode;
}

export function Toolbar({ label, children }: ToolbarProps) {
  return (
    <div className="ink-toolbar" role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

export interface StatusEntry {
  readonly id: string;
  readonly label: string;
  readonly value: ReactNode;
}

export interface StatusBarProps {
  readonly label: string;
  readonly entries: readonly StatusEntry[];
}

export function StatusBar({ label, entries }: StatusBarProps) {
  return (
    <footer className="ink-status-bar" aria-label={label} role="status">
      {entries.map((entry) => (
        <span key={entry.id} className="ink-status-entry">
          <span className="ink-visually-hidden">{entry.label}:</span>
          {entry.value}
        </span>
      ))}
    </footer>
  );
}

export interface InspectorSectionProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly visibility?: "expanded" | "collapsed";
  readonly onVisibilityChange?: (visibility: "expanded" | "collapsed") => void;
  readonly actions?: ReactNode;
}

export function InspectorSection({
  title,
  children,
  visibility = "expanded",
  onVisibilityChange,
  actions,
}: InspectorSectionProps) {
  return (
    <section className="ink-inspector-section">
      <details
        open={visibility === "expanded"}
        onToggle={(event) =>
          onVisibilityChange?.(
            event.currentTarget.open ? "expanded" : "collapsed",
          )}
      >
        <summary>
          <span>{title}</span>
          {actions && <span className="ink-inspector-actions">{actions}</span>}
        </summary>
        <div className="ink-inspector-content">{children}</div>
      </details>
    </section>
  );
}

export interface PropertyRowProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly description?: string;
}

export function PropertyRow(
  { label, children, description }: PropertyRowProps,
) {
  return (
    <div className="ink-property-row">
      <span className="ink-property-label" title={description}>{label}</span>
      <div className="ink-property-control">{children}</div>
    </div>
  );
}
