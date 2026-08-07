import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import type { Interaction } from "./controls.tsx";

export interface OutlinerNode {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly children?: readonly OutlinerNode[];
  readonly interaction?: Interaction;
}

export interface OutlinerProps {
  readonly label: string;
  readonly nodes: readonly OutlinerNode[];
  readonly selected_id?: string;
  readonly expanded_ids: ReadonlySet<string>;
  readonly onSelect: (id: string) => void;
  readonly onExpandedChange: (
    id: string,
    visibility: "expanded" | "collapsed",
  ) => void;
}

export function Outliner({
  label,
  nodes,
  selected_id,
  expanded_ids,
  onSelect,
  onExpandedChange,
}: OutlinerProps) {
  const ordered_ids = visible_outliner(nodes, expanded_ids)
    .filter((node) => node.interaction !== "disabled")
    .map((node) => node.id);
  return (
    <ul className="ink-outliner" role="tree" aria-label={label}>
      {nodes.map((node) => (
        <OutlinerBranch
          key={node.id}
          node={node}
          level={1}
          ordered_ids={ordered_ids}
          selected_id={selected_id}
          expanded_ids={expanded_ids}
          onSelect={onSelect}
          onExpandedChange={onExpandedChange}
        />
      ))}
    </ul>
  );
}

interface OutlinerBranchProps extends Omit<OutlinerProps, "label" | "nodes"> {
  readonly node: OutlinerNode;
  readonly level: number;
  readonly ordered_ids: readonly string[];
}

function OutlinerBranch({
  node,
  level,
  ordered_ids,
  selected_id,
  expanded_ids,
  onSelect,
  onExpandedChange,
}: OutlinerBranchProps) {
  const has_children = (node.children?.length ?? 0) > 0;
  const expanded = has_children && expanded_ids.has(node.id);
  const selected = node.id === selected_id;
  const focusable = ordered_ids.includes(selected_id ?? "")
    ? selected
    : ordered_ids[0] === node.id;
  const navigate = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = ordered_ids.indexOf(node.id);
    if (event.key === "ArrowDown" && current < ordered_ids.length - 1) {
      event.preventDefault();
      focus_outliner_row(event, current + 1);
      onSelect(ordered_ids[current + 1]);
    }
    if (event.key === "ArrowUp" && current > 0) {
      event.preventDefault();
      focus_outliner_row(event, current - 1);
      onSelect(ordered_ids[current - 1]);
    }
    if (event.key === "ArrowRight" && has_children) {
      event.preventDefault();
      onExpandedChange(node.id, "expanded");
    }
    if (event.key === "ArrowLeft" && has_children) {
      event.preventDefault();
      onExpandedChange(node.id, "collapsed");
    }
  };
  return (
    <li
      role="treeitem"
      aria-level={level}
      aria-selected={selected}
      aria-expanded={has_children ? expanded : undefined}
      data-selected={selected ? "true" : undefined}
    >
      <div className="ink-outliner-row">
        {has_children
          ? (
            <button
              type="button"
              className="ink-tree-toggle"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${node.label}`}
              onClick={() =>
                onExpandedChange(node.id, expanded ? "collapsed" : "expanded")}
            >
              <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
            </button>
          )
          : <span className="ink-tree-spacer" />}
        <button
          type="button"
          className="ink-outliner-select"
          disabled={node.interaction === "disabled"}
          tabIndex={focusable ? 0 : -1}
          onClick={() => onSelect(node.id)}
          onKeyDown={navigate}
        >
          {node.icon && <span aria-hidden="true">{node.icon}</span>}
          <span>{node.label}</span>
        </button>
      </div>
      {expanded && (
        <ul role="group">
          {node.children?.map((child) => (
            <OutlinerBranch
              key={child.id}
              node={child}
              level={level + 1}
              ordered_ids={ordered_ids}
              selected_id={selected_id}
              expanded_ids={expanded_ids}
              onSelect={onSelect}
              onExpandedChange={onExpandedChange}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function focus_outliner_row(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
): void {
  event.currentTarget.closest('[role="tree"]')
    ?.querySelectorAll<HTMLButtonElement>(".ink-outliner-select")[index]
    ?.focus();
}

export function flatten_outliner(
  nodes: readonly OutlinerNode[],
): readonly OutlinerNode[] {
  const flattened: OutlinerNode[] = [];
  const visit = (node: OutlinerNode) => {
    flattened.push(node);
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return flattened;
}

export function visible_outliner(
  nodes: readonly OutlinerNode[],
  expanded_ids: ReadonlySet<string>,
): readonly OutlinerNode[] {
  const visible: OutlinerNode[] = [];
  const visit = (node: OutlinerNode) => {
    visible.push(node);
    if (expanded_ids.has(node.id)) node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return visible;
}

export interface EditorAsset {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly thumbnail_url?: string;
}

export interface AssetGridProps {
  readonly label: string;
  readonly assets: readonly EditorAsset[];
  readonly selected_id?: string;
  readonly onSelect: (id: string) => void;
}

export function AssetGrid({
  label,
  assets,
  selected_id,
  onSelect,
}: AssetGridProps) {
  return (
    <ul className="ink-asset-grid" aria-label={label}>
      {assets.map((asset) => (
        <li key={asset.id}>
          <button
            type="button"
            aria-pressed={asset.id === selected_id}
            onClick={() => onSelect(asset.id)}
          >
            <span className="ink-asset-preview">
              {asset.thumbnail_url
                ? <img src={asset.thumbnail_url} alt="" />
                : <span aria-hidden="true">◇</span>}
            </span>
            <span className="ink-asset-name">{asset.name}</span>
            <span className="ink-asset-kind">{asset.kind}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface EditorCommand {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly shortcut?: string;
  readonly interaction?: Interaction;
}

export interface CommandPaletteProps {
  readonly label: string;
  readonly visibility: "open" | "closed";
  readonly query: string;
  readonly commands: readonly EditorCommand[];
  readonly onQueryChange: (query: string) => void;
  readonly onExecute: (id: string) => void;
  readonly onDismiss: () => void;
}

export function CommandPalette({
  label,
  visibility,
  query,
  commands,
  onQueryChange,
  onExecute,
  onDismiss,
}: CommandPaletteProps) {
  const list_id = useId();
  const dialog_reference = useRef<HTMLDialogElement>(null);
  const prop_driven_close = useRef(false);
  const matches = filter_commands(commands, query);
  useEffect(() => {
    const dialog = dialog_reference.current;
    if (dialog === null) return;
    if (visibility === "open" && !dialog.open) dialog.showModal();
    if (visibility === "closed" && dialog.open) {
      prop_driven_close.current = true;
      dialog.close();
    }
  }, [visibility]);
  return (
    <dialog
      ref={dialog_reference}
      className="ink-command-palette"
      aria-label={label}
      aria-modal="true"
      onClose={() => {
        if (prop_driven_close.current) {
          prop_driven_close.current = false;
          return;
        }
        onDismiss();
      }}
    >
      <input
        type="search"
        value={query}
        aria-label="Search commands"
        aria-controls={list_id}
        placeholder="Type a command"
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDismiss();
          if (event.key === "Enter" && matches[0]?.interaction !== "disabled") {
            onExecute(matches[0].id);
          }
        }}
      />
      <ul id={list_id} role="listbox" aria-label="Matching commands">
        {matches.map((command) => (
          <li key={command.id} role="option" aria-selected="false">
            <button
              type="button"
              disabled={command.interaction === "disabled"}
              onClick={() =>
                onExecute(command.id)}
            >
              <span>
                <small>{command.group}</small>
                {command.label}
              </span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>
          </li>
        ))}
      </ul>
      {matches.length === 0 && (
        <p className="ink-empty-inline">No matching commands</p>
      )}
    </dialog>
  );
}

export function filter_commands(
  commands: readonly EditorCommand[],
  query: string,
): readonly EditorCommand[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return commands;
  return commands.filter((command) => {
    const searchable = `${command.group} ${command.label} ${
      command.shortcut ?? ""
    }`.toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}
