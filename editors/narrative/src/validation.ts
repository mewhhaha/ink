import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "../../../packages/authoring/src/diagnostics.ts";
import type { NarrativeProject } from "./model.ts";
export function validate_narrative_project(
  project: NarrativeProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const scenes = new Set(project.scenes.map(({ id }) => id));
  const variables = new Set(project.variables.map(({ id }) => id));
  const evidence = new Set(project.evidence.map(({ id }) => id));
  if (!scenes.has(project.initial_scene)) {
    diagnostics.push(
      problem(
        "UNKNOWN_INITIAL_SCENE",
        `Initial scene ${project.initial_scene} does not exist.`,
        "Choose an existing initial scene.",
      ),
    );
  }
  if (project.endings.length === 0) {
    diagnostics.push(
      problem(
        "MISSING_ENDING",
        "Narrative project has no ending.",
        "Mark at least one scene as an ending.",
      ),
    );
  }
  for (const scene of project.scenes) {
    for (const choice of scene.choices) {
      if (!scenes.has(choice.destination)) {
        diagnostics.push(
          problem(
            "UNKNOWN_CHOICE_DESTINATION",
            `Choice ${choice.id} points to missing scene ${choice.destination}.`,
            "Choose an existing destination.",
          ),
        );
      }
      if (
        choice.reveals_evidence !== null &&
        !evidence.has(choice.reveals_evidence)
      ) {
        diagnostics.push(
          problem(
            "UNKNOWN_EVIDENCE",
            `Choice ${choice.id} reveals missing evidence ${choice.reveals_evidence}.`,
            "Choose existing evidence.",
          ),
        );
      }
      for (const condition of choice.conditions) {
        if (!variables.has(condition.variable)) {
          diagnostics.push(
            problem(
              "UNKNOWN_VARIABLE",
              `Choice ${choice.id} tests missing variable ${condition.variable}.`,
              "Choose an existing variable.",
            ),
          );
        }
      }
    }
  }
  for (const ending of project.endings) {
    if (!scenes.has(ending.scene)) {
      diagnostics.push(
        problem(
          "UNKNOWN_ENDING_SCENE",
          `Ending ${ending.id} uses missing scene ${ending.scene}.`,
          "Choose an existing scene.",
        ),
      );
    }
  }
  return diagnostics;
}
function problem(
  code: string,
  message: string,
  recovery: string,
): AuthoringDiagnostic {
  return authoring_diagnostic({ code, severity: "error", message, recovery });
}
