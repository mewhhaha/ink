import { Outliner } from "@ink/editor-ui/collections.tsx";
import { useState } from "react";
import type { PlatformerProject, PlatformerRecord } from "./model.ts";

export interface PlatformerWorkspaceProps {
  readonly project: PlatformerProject;
  readonly selected_record_id?: string;
  readonly onMoveExit: () => void;
  readonly onSelectRecord: (record_id: string) => void;
}

export function PlatformerWorkspace({
  project,
  selected_record_id,
  onMoveExit,
  onSelectRecord,
}: PlatformerWorkspaceProps) {
  const [expanded_nodes, set_expanded_nodes] = useState<ReadonlySet<string>>(
    () =>
      new Set(project.levels.flatMap((level) => [
        `level:${level.id}`,
        ...level.layers.map(({ id }) => `layer:${id}`),
      ])),
  );
  const entry = project.levels.find(({ id }) => id === project.entry_level_id);
  if (entry === undefined) {
    throw new Error(
      `platformer project ${project.id} entry level ${project.entry_level_id} is missing`,
    );
  }
  const records = entry.layers.flatMap(({ records }) => records);
  const exit = records.find((record) => record.kind === "exit");
  if (exit === undefined) {
    throw new Error(`platformer level ${entry.id} has no exit`);
  }

  return (
    <section aria-label={`${project.name} workspace`}>
      <header>
        <strong>{entry.name}</strong>
        <small>{records.length} authored records</small>
      </header>
      <Outliner
        label="Platformer level"
        nodes={[{
          id: `level:${entry.id}`,
          label: entry.name,
          children: entry.layers.map((layer) => ({
            id: `layer:${layer.id}`,
            label: layer.name,
            children: layer.records.map(record_node),
          })),
        }]}
        selected_id={selected_record_id === undefined
          ? undefined
          : `record:${selected_record_id}`}
        expanded_ids={expanded_nodes}
        onSelect={(id) => {
          if (id.startsWith("record:")) onSelectRecord(id.slice(7));
        }}
        onExpandedChange={(id, visibility) => {
          const next = new Set(expanded_nodes);
          if (visibility === "expanded") next.add(id);
          else next.delete(id);
          set_expanded_nodes(next);
        }}
      />
      <p>
        Exit: {exit.bounds.minimum.x}–{exit.bounds.maximum.x} ×{" "}
        {exit.bounds.minimum.y}–{exit.bounds.maximum.y}
      </p>
      <button type="button" onClick={onMoveExit}>Move exit right</button>
    </section>
  );
}

function record_node(record: PlatformerRecord) {
  return {
    id: `record:${record.id}`,
    label: `${record.name} · ${record.kind.replaceAll("_", " ")}`,
  };
}
