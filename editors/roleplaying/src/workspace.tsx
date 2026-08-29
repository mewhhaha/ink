import { Outliner } from "@ink/editor-ui/collections.tsx";
import { useState } from "react";
import type { RoleplayingProject } from "./model.ts";

export interface RoleplayingWorkspaceProps {
  readonly project: RoleplayingProject;
  readonly selected_region_id: string;
  readonly onAddLoot: () => void;
  readonly onSelectRegion: (region_id: string) => void;
}

export function RoleplayingWorkspace({
  project,
  selected_region_id,
  onAddLoot,
  onSelectRegion,
}: RoleplayingWorkspaceProps) {
  const [expanded, set_expanded] = useState<ReadonlySet<string>>(
    () => new Set(["world"]),
  );
  const region = project.regions.find(({ id }) => id === selected_region_id);
  if (region === undefined) {
    throw new Error(
      `role-playing project ${project.id} has no region ${selected_region_id}`,
    );
  }
  const loot = project.loot.filter(({ region_id }) => region_id === region.id);
  return (
    <section aria-label={`${project.name} role-playing workspace`}>
      <header>
        <strong>{region.label}</strong>
        <small>
          {loot.flatMap(({ entries }) => entries).length} loot entries
        </small>
      </header>
      <Outliner
        label="Role-playing regions"
        nodes={[{
          id: "world",
          label: project.name,
          children: project.regions.map((candidate) => ({
            id: `region:${candidate.id}`,
            label: candidate.label,
          })),
        }]}
        selected_id={`region:${selected_region_id}`}
        expanded_ids={expanded}
        onSelect={(id) => {
          if (id.startsWith("region:")) onSelectRegion(id.slice(7));
        }}
        onExpandedChange={(id, visibility) => {
          const next = new Set(expanded);
          if (visibility === "expanded") next.add(id);
          else next.delete(id);
          set_expanded(next);
        }}
      />
      <ul>
        {loot.flatMap(({ entries }) => entries).map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
      <button type="button" onClick={onAddLoot}>Add moonstone relic</button>
    </section>
  );
}
