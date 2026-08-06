import { editor_preset_id } from "../../../packages/authoring/src/identity.ts";
import type { NarrativeProject } from "./model.ts";
export function create_narrative_starter_project(
  preset = editor_preset_id("branching-vn"),
): NarrativeProject {
  return {
    revision: 0,
    preset,
    initial_scene: "station",
    variables: [{ id: "trust", initial: 0 }],
    evidence: [{ id: "signal", label: "Unfamiliar signal" }],
    scenes: [
      {
        id: "station",
        beats: [{
          id: "arrival",
          speaker: "Mara",
          text: "The last train waits beneath a sky full of signals.",
        }],
        choices: [
          {
            id: "follow-signal",
            label: "Follow the signal",
            destination: "observatory",
            conditions: [],
            reveals_evidence: "signal",
          },
          {
            id: "board-train",
            label: "Board the train",
            destination: "harbor",
            conditions: [{ variable: "trust", equals: 0 }],
            reveals_evidence: null,
          },
        ],
      },
      {
        id: "observatory",
        beats: [{
          id: "answer",
          speaker: "Mara",
          text: "The observatory answers with your forgotten call sign.",
        }],
        choices: [],
      },
      {
        id: "harbor",
        beats: [{
          id: "dawn",
          speaker: "Conductor",
          text: "At dawn, the train opens onto a quiet harbor.",
        }],
        choices: [],
      },
    ],
    endings: [{
      id: "signal-ending",
      scene: "observatory",
      label: "The Answer",
    }, { id: "harbor-ending", scene: "harbor", label: "A New Shore" }],
  };
}
