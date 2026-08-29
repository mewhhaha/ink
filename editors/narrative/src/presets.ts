import { editor_preset_id } from "@ink/authoring/identity.ts";
import {
  narrative_beat_id,
  narrative_choice_id,
  narrative_ending_id,
  narrative_evidence_id,
  narrative_project_id,
  narrative_scene_id,
  narrative_variable_id,
} from "./identity.ts";
import { narrative_project, type NarrativeProject } from "./model.ts";

export function create_narrative_starter_project(): NarrativeProject {
  return narrative_project({
    schema_version: 1,
    id: narrative_project_id("last-train"),
    name: "The Last Signal",
    preset_id: editor_preset_id("branching-vn"),
    initial_scene_id: narrative_scene_id("station"),
    variables: [{ id: narrative_variable_id("trust"), initial: 0 }],
    evidence: [
      { id: narrative_evidence_id("signal"), label: "Unfamiliar signal" },
      { id: narrative_evidence_id("ticket"), label: "Silver train ticket" },
    ],
    scenes: [
      {
        id: narrative_scene_id("station"),
        title: "The Last Station",
        beats: [{
          id: narrative_beat_id("arrival"),
          speaker: "Mara",
          text: "The last train waits beneath a sky full of signals.",
        }],
        choices: [
          {
            id: narrative_choice_id("follow-signal"),
            label: "Follow the signal",
            destination_scene_id: narrative_scene_id("observatory"),
            conditions: [],
            reveals_evidence_ids: [narrative_evidence_id("signal")],
          },
          {
            id: narrative_choice_id("board-train"),
            label: "Board the train",
            destination_scene_id: narrative_scene_id("harbor"),
            conditions: [{
              variable_id: narrative_variable_id("trust"),
              equals: 0,
            }],
            reveals_evidence_ids: [narrative_evidence_id("ticket")],
          },
        ],
      },
      {
        id: narrative_scene_id("observatory"),
        title: "The Observatory",
        beats: [{
          id: narrative_beat_id("answer"),
          speaker: "Mara",
          text: "The observatory answers with your forgotten call sign.",
        }],
        choices: [],
      },
      {
        id: narrative_scene_id("harbor"),
        title: "A Quiet Harbor",
        beats: [{
          id: narrative_beat_id("dawn"),
          speaker: "Conductor",
          text: "At dawn, the train opens onto a quiet harbor.",
        }],
        choices: [],
      },
    ],
    endings: [
      {
        id: narrative_ending_id("signal-ending"),
        scene_id: narrative_scene_id("observatory"),
        label: "The Answer",
      },
      {
        id: narrative_ending_id("harbor-ending"),
        scene_id: narrative_scene_id("harbor"),
        label: "A New Shore",
      },
    ],
  });
}
