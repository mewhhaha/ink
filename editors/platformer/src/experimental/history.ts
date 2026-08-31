import {
  type AuthoringHistory,
  commit_authoring_revision,
  create_authoring_history,
  type HistoryChange,
  redo_authoring_revision,
  undo_authoring_revision,
} from "@ink/authoring/experimental/history.ts";
import type { PlatformerProject } from "../model.ts";

export type PlatformerHistory = AuthoringHistory<PlatformerProject>;
export type PlatformerHistoryChange = HistoryChange<PlatformerProject>;

export function create_platformer_history(
  project: PlatformerProject,
): PlatformerHistory {
  return create_authoring_history(project);
}

export function commit_platformer_revision(
  history: PlatformerHistory,
  label: string,
  project: PlatformerProject,
  maximum_revisions = 100,
): PlatformerHistory {
  return commit_authoring_revision(
    history,
    label,
    project,
    maximum_revisions,
  );
}

export function undo_platformer_revision(
  history: PlatformerHistory,
): PlatformerHistoryChange {
  return undo_authoring_revision(history);
}

export function redo_platformer_revision(
  history: PlatformerHistory,
): PlatformerHistoryChange {
  return redo_authoring_revision(history);
}
