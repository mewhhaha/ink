import { Outliner } from "@ink/editor-ui/collections.tsx";
import { useState } from "react";
import type { AdventureDocument } from "./document.ts";

export interface AdventureWorkspaceProps {
  readonly document: AdventureDocument;
  readonly selected_brush_slot: number | null;
  readonly onSelectBrush: (slot: number) => void;
}

export function AdventureWorkspace({
  document,
  selected_brush_slot,
  onSelectBrush,
}: AdventureWorkspaceProps) {
  const [expanded_nodes, set_expanded_nodes] = useState<ReadonlySet<string>>(
    () => new Set(["layout"]),
  );
  const bound_interactions = new Map(
    document.layout.interaction_bindings.map(({ brush, interaction }) => [
      brush,
      interaction,
    ]),
  );
  const brushes = document.layout.brushes.map((brush) => ({
    id: String(brush.slot),
    label: bound_interactions.has(brush.id)
      ? `${brush.id} · ${bound_interactions.get(brush.id)}`
      : brush.id,
    icon: <span>{brush.kind === "door" ? "▥" : "▦"}</span>,
  }));

  return (
    <section
      className="ink-adventure-workspace"
      aria-label={`${document.project.title} workspace`}
    >
      <header>
        <strong>{document.layout.name}</strong>
        <small>
          {document.project.rooms.length} rooms ·{" "}
          {document.project.interactions.length}
          {" interactions"}
        </small>
      </header>
      <Outliner
        label="Adventure layout"
        nodes={[{
          id: "layout",
          label: "Level geometry",
          children: brushes,
        }]}
        selected_id={selected_brush_slot === null
          ? undefined
          : String(selected_brush_slot)}
        expanded_ids={expanded_nodes}
        onSelect={(id) => {
          if (id === "layout") return;
          onSelectBrush(Number(id));
        }}
        onExpandedChange={(id, visibility) => {
          const next = new Set(expanded_nodes);
          if (visibility === "expanded") next.add(id);
          else next.delete(id);
          set_expanded_nodes(next);
        }}
      />
    </section>
  );
}
