import { Outliner } from "@ink/editor-ui/collections.tsx";
import { useState } from "react";
import { narrative_editor } from "./catalog.ts";
import type { NarrativeProject } from "./model.ts";

export interface NarrativeWorkspaceProps {
  readonly project: NarrativeProject;
  readonly selected_scene_id: string;
  readonly onAddBeat: () => void;
  readonly onSelectScene: (scene_id: string) => void;
}

export function NarrativeWorkspace({
  project,
  selected_scene_id,
  onAddBeat,
  onSelectScene,
}: NarrativeWorkspaceProps) {
  const [expanded_nodes, set_expanded_nodes] = useState<ReadonlySet<string>>(
    () => new Set(["story"]),
  );
  const scene = project.scenes.find(({ id }) => id === selected_scene_id);
  if (scene === undefined) {
    throw new Error(
      `narrative project ${project.id} has no selected scene ${selected_scene_id}`,
    );
  }
  return (
    <section aria-label={`${project.name} narrative workspace`}>
      <header>
        <span>
          <small>{narrative_editor.label} editor</small>
          <strong>{scene.title}</strong>
        </span>
        <small>{scene.beats.length} authored beats</small>
      </header>
      <p>{narrative_editor.summary}</p>
      <Outliner
        label="Narrative scenes"
        nodes={[{
          id: "story",
          label: project.name,
          children: project.scenes.map((candidate) => ({
            id: `scene:${candidate.id}`,
            label: `${candidate.title} · ${candidate.beats.length} beats`,
          })),
        }]}
        selected_id={`scene:${selected_scene_id}`}
        expanded_ids={expanded_nodes}
        onSelect={(id) => {
          if (id.startsWith("scene:")) onSelectScene(id.slice(6));
        }}
        onExpandedChange={(id, visibility) => {
          const next = new Set(expanded_nodes);
          if (visibility === "expanded") next.add(id);
          else next.delete(id);
          set_expanded_nodes(next);
        }}
      />
      <ol aria-label={`${scene.title} beats`}>
        {scene.beats.map((beat) => (
          <li key={beat.id}>
            <strong>{beat.speaker}</strong> {beat.text}
          </li>
        ))}
      </ol>
      <button type="button" onClick={onAddBeat}>
        Add signal warning
      </button>
    </section>
  );
}
