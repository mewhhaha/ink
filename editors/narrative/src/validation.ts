import {
  authoring_diagnostic,
  type AuthoringDiagnostic,
} from "@ink/authoring/diagnostics.ts";
import type { NarrativeProject } from "./model.ts";

export function validate_narrative_project(
  project: NarrativeProject,
): readonly AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const scene_ids = duplicate_diagnostics(
    project.scenes,
    "DUPLICATE_SCENE",
    "scene",
    diagnostics,
  );
  const variable_ids = duplicate_diagnostics(
    project.variables,
    "DUPLICATE_VARIABLE",
    "variable",
    diagnostics,
  );
  const evidence_ids = duplicate_diagnostics(
    project.evidence,
    "DUPLICATE_EVIDENCE",
    "evidence",
    diagnostics,
  );
  duplicate_diagnostics(
    project.endings,
    "DUPLICATE_ENDING",
    "ending",
    diagnostics,
  );

  if (!scene_ids.has(project.initial_scene_id)) {
    report(
      diagnostics,
      "UNKNOWN_INITIAL_SCENE",
      `Project ${project.id} initial scene ${project.initial_scene_id} does not exist.`,
      `project:${project.id}`,
      "Choose an existing initial scene.",
    );
  }
  if (project.endings.length === 0) {
    report(
      diagnostics,
      "MISSING_ENDING",
      `Project ${project.id} has no ending.`,
      `project:${project.id}`,
      "Mark at least one scene as an ending.",
    );
  }

  const beat_ids = new Set<string>();
  const choice_ids = new Set<string>();
  for (const scene of project.scenes) {
    if (scene.beats.length === 0) {
      report(
        diagnostics,
        "EMPTY_SCENE",
        `Scene ${scene.id} contains no dialogue beats.`,
        `scene:${scene.id}`,
        "Add at least one beat to the scene.",
      );
    }
    for (const beat of scene.beats) {
      report_duplicate(
        beat_ids,
        beat.id,
        "DUPLICATE_BEAT",
        "beat",
        diagnostics,
      );
    }
    for (const choice of scene.choices) {
      report_duplicate(
        choice_ids,
        choice.id,
        "DUPLICATE_CHOICE",
        "choice",
        diagnostics,
      );
      if (!scene_ids.has(choice.destination_scene_id)) {
        report(
          diagnostics,
          "UNKNOWN_CHOICE_DESTINATION",
          `Choice ${choice.id} points to missing scene ${choice.destination_scene_id}.`,
          `choice:${choice.id}`,
          "Choose an existing destination scene.",
        );
      }
      const tested_variables = new Set<string>();
      for (const condition of choice.conditions) {
        if (!variable_ids.has(condition.variable_id)) {
          report(
            diagnostics,
            "UNKNOWN_VARIABLE",
            `Choice ${choice.id} tests missing variable ${condition.variable_id}.`,
            `choice:${choice.id}`,
            "Choose an existing variable.",
          );
        }
        report_duplicate(
          tested_variables,
          condition.variable_id,
          "DUPLICATE_CHOICE_CONDITION",
          "condition variable",
          diagnostics,
        );
      }
      const revealed_evidence = new Set<string>();
      for (const evidence_id of choice.reveals_evidence_ids) {
        if (!evidence_ids.has(evidence_id)) {
          report(
            diagnostics,
            "UNKNOWN_EVIDENCE",
            `Choice ${choice.id} reveals missing evidence ${evidence_id}.`,
            `choice:${choice.id}`,
            "Choose existing evidence.",
          );
        }
        report_duplicate(
          revealed_evidence,
          evidence_id,
          "DUPLICATE_CHOICE_EVIDENCE",
          "revealed evidence",
          diagnostics,
        );
      }
    }
  }

  const ending_scenes = new Set<string>();
  for (const ending of project.endings) {
    if (!scene_ids.has(ending.scene_id)) {
      report(
        diagnostics,
        "UNKNOWN_ENDING_SCENE",
        `Ending ${ending.id} uses missing scene ${ending.scene_id}.`,
        `ending:${ending.id}`,
        "Choose an existing scene.",
      );
    }
    report_duplicate(
      ending_scenes,
      ending.scene_id,
      "DUPLICATE_ENDING_SCENE",
      "ending scene",
      diagnostics,
    );
    const scene = project.scenes.find(({ id }) => id === ending.scene_id);
    if (scene !== undefined && scene.choices.length > 0) {
      report(
        diagnostics,
        "ENDING_HAS_CHOICES",
        `Ending ${ending.id} scene ${ending.scene_id} still contains choices.`,
        `ending:${ending.id}`,
        "Remove the ending scene choices or move the ending marker.",
      );
    }
  }

  for (const scene_id of unreachable_scene_ids(project)) {
    report(
      diagnostics,
      "UNREACHABLE_SCENE",
      `Scene ${scene_id} cannot be reached from ${project.initial_scene_id}.`,
      `scene:${scene_id}`,
      "Connect the scene from a reachable choice or remove it.",
    );
  }
  return Object.freeze(diagnostics);
}

function duplicate_diagnostics(
  entries: readonly { readonly id: string }[],
  code: string,
  label: string,
  diagnostics: AuthoringDiagnostic[],
): ReadonlySet<string> {
  const identities = new Set<string>();
  for (const entry of entries) {
    report_duplicate(identities, entry.id, code, label, diagnostics);
  }
  return identities;
}

function report_duplicate(
  identities: Set<string>,
  id: string,
  code: string,
  label: string,
  diagnostics: AuthoringDiagnostic[],
): void {
  if (identities.has(id)) {
    report(
      diagnostics,
      code,
      `Narrative ${label} ${id} appears more than once.`,
      `${label}:${id}`,
      `Give every ${label} a unique identity.`,
    );
  }
  identities.add(id);
}

function unreachable_scene_ids(project: NarrativeProject): readonly string[] {
  const scenes = new Map(project.scenes.map((scene) => [scene.id, scene]));
  const reached = new Set<string>();
  const pending = [project.initial_scene_id];
  while (pending.length > 0) {
    const scene_id = pending.pop();
    if (scene_id === undefined || reached.has(scene_id)) continue;
    reached.add(scene_id);
    const scene = scenes.get(scene_id);
    if (scene === undefined) continue;
    for (const choice of scene.choices) {
      pending.push(choice.destination_scene_id);
    }
  }
  return project.scenes.flatMap(({ id }) => reached.has(id) ? [] : [id]);
}

function report(
  diagnostics: AuthoringDiagnostic[],
  code: string,
  message: string,
  subject: string,
  recovery: string,
): void {
  diagnostics.push(authoring_diagnostic({
    code,
    severity: "error",
    message,
    subject,
    recovery,
  }));
}
