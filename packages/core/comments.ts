/**
 * Comments pinned to the world: to an entity, a point, or just a view. They
 * are how a person points at something for a collaborator or an agent ("this
 * door clips through the wall"). Stored as `.ink/comments.json`.
 */
import type { Vec3, Vec4 } from "@ink/schema";

/** An editor or game camera, enough to reproduce what was on screen. */
export interface CameraPose {
  position: Vec3;
  rotation: Vec4;
  fov: number;
  orthographic?: boolean;
  /** Orthographic height. */
  size?: number;
  /** Which view it came from: "game", "editor", "top", ... */
  view?: string;
}

export interface CommentReply {
  /** Stable identity for merging simultaneous replies. */
  id?: string;
  author: string;
  text: string;
  created: string;
  captures?: CommentCapture[];
}

export interface CommentCapture {
  label: "before" | "after" | "evidence";
  /** Project-relative capture path. */
  path: string;
  tick: number;
  view?: string;
}

export type CommentStatus = "open" | "in_progress" | "blocked" | "resolved";
export const commentStatuses: CommentStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "resolved",
];

export interface Comment {
  id: string;
  created: string;
  author: string;
  text: string;
  status: CommentStatus;
  assignee?: string;
  /** Saved hand-off containing this report's state and recorded inputs. */
  handoff?: string;
  anchor: {
    entity?: number;
    entityName?: string;
    /** World position of the pin when it was placed. */
    point?: Vec3;
    /** The pin in the entity's local space, so it follows the entity. */
    local?: Vec3;
    view?: CameraPose;
    mode: "edit" | "play";
    tick: number;
    /** Inclusive timeline range. */
    range?: { from: number; to: number };
    /** Project-relative source location, e.g. from a compiler diagnostic. */
    code?: { file: string; line: number; endLine?: number; column?: number };
    scene?: string;
  };
  /** Path of a screenshot relative to the project, if one was taken. */
  screenshot?: string;
  replies?: CommentReply[];
}

export function commentId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Comments arrive from a file anyone can edit; keep the well-formed ones. */
export function parseComments(value: unknown): Comment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is Comment =>
    typeof c === "object" && c !== null && typeof c.id === "string" &&
    typeof c.text === "string" && typeof c.anchor === "object" &&
    c.anchor !== null
  ).map((c) => ({
    ...c,
    status: commentStatuses.includes(c.status) ? c.status : "open",
    author: typeof c.author === "string" ? c.author : "unknown",
    created: typeof c.created === "string"
      ? c.created
      : new Date(0).toISOString(),
    replies: Array.isArray(c.replies)
      ? c.replies.filter((r) =>
        r && typeof r.text === "string" && typeof r.author === "string"
      )
      : [],
  }));
}
