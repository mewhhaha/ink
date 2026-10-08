/**
 * A hand-off is everything a collaborator (usually a coding agent) needs to
 * see and reproduce a moment: what the person wrote, screenshots, the exact
 * state, a replayable input log, the console, open comments and diagnostics,
 * as files under `.ink/handoffs/<id>/` with a `handoff.md` index.
 */
import { worldToScene } from "@ink/schema";
import type { CameraPose } from "./comments.ts";
import { commentId } from "./comments.ts";
import type { Session } from "./session.ts";

export interface HandoffFile {
  name: string;
  text?: string;
  base64?: string;
}

export interface HandoffOptions {
  note: string;
  /** PNG screenshots, as data URLs or raw base64. */
  screenshots?: { name: string; png: string; caption?: string }[];
  /** Camera the main screenshot was taken from. */
  view?: CameraPose;
  /** Project path for the reproduction commands, e.g. "examples/godot". */
  project?: string;
  /** Seconds of input history to include for exact replay. */
  replaySeconds?: number;
}

export interface Handoff {
  id: string;
  files: HandoffFile[];
  markdown: string;
}

export function buildHandoff(
  session: Session,
  options: HandoffOptions,
): Handoff {
  const id = commentId();
  const project = options.project ?? "<project>";
  // Paths in the index are relative to the workspace, where the commands run.
  const dir = `${
    options.project ? `${options.project}/` : ""
  }.ink/handoffs/${id}`;
  const world = session.world;
  const state = session.toScene(session.current);
  const files: HandoffFile[] = [];
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

  files.push({ name: "state.scene.json", text: json(state) });
  if (session.mode === "play") {
    files.push({ name: "document.scene.json", text: json(session.toScene()) });
  }

  // Exact replay: the nearest keyframe far enough back, plus inputs to now.
  let replay: { from: number; to: number } | undefined;
  if (session.mode === "play") {
    const now = session.tick;
    const want = now -
      Math.round((options.replaySeconds ?? 10) * session.tickRate);
    const keyframe =
      session.timeline.nearest(Math.max(want, session.timeline.first)) ??
        session.timeline.nearest(now);
    if (keyframe) {
      const keyWorld = session.worldOf({ ...keyframe, names: session.names });
      const inputs = session.timeline.between(keyframe.tick, now);
      files.push({
        name: "replay.json",
        text: json({
          keyframe: worldToScene(
            keyframe.schema,
            keyWorld,
            session.names,
            keyframe.catalog,
          ),
          inputs,
          reloads: session.timeline.marks.filter((m) =>
            m.tick >= keyframe.tick
          ),
        }),
      });
      replay = { from: keyframe.tick, to: now };
    }
  }

  const screenshots = (options.screenshots ?? []).map((shot) => {
    const name = shot.name.endsWith(".png") ? shot.name : `${shot.name}.png`;
    files.push({
      name,
      base64: shot.png.replace(/^data:image\/png;base64,/, ""),
    });
    return { ...shot, name };
  });

  const recent = session.log.slice(-40);
  files.push({ name: "console.json", text: json(recent) });
  const open = session.comments.filter((c) => c.status === "open");

  const lines: string[] = [];
  const title = options.note.trim().split("\n")[0]?.slice(0, 80) ||
    "Untitled hand-off";
  lines.push(`# ${title}`, "");
  const body = options.note.trim().split("\n").slice(1).join("\n").trim();
  if (body) lines.push(body, "");
  const status = session.status;
  const game = status.kind === "ready"
    ? `rev ${status.revision}`
    : status.kind === "error"
    ? `build errors (running rev ${status.revision ?? "none"})`
    : status.kind;
  const mode = session.mode === "play"
    ? `play, ${
      session.paused ? "paused" : "running"
    } at tick ${session.tick} (${session.time.toFixed(1)} s)`
    : `edit${session.dirty ? " (unsaved changes)" : ""}`;
  const selected =
    session.selection.map((id) => `${session.nameOf(id)} (#${id})`).join(
      ", ",
    ) ||
    "nothing";
  lines.push(
    "| | |",
    "| --- | --- |",
    `| Created | ${new Date().toISOString()} |`,
    `| Scene | ${session.sceneName} |`,
    `| Mode | ${mode} |`,
    `| Game | ${game} |`,
    `| Entities | ${world.entities.length} |`,
    `| Selection | ${selected} |`,
    "",
  );
  for (const shot of screenshots) {
    lines.push(`![${shot.caption ?? shot.name}](${shot.name})`, "");
    if (shot.caption) lines.push(`_${shot.caption}_`, "");
  }
  if (options.view) {
    lines.push(
      "Camera: " + "`" + JSON.stringify(options.view) + "`",
      "",
    );
  }

  if (session.selection.length > 0) {
    lines.push("## Selected entities", "");
    for (const id of session.selection) {
      const entity = state.entities.find((e) => e.id === id);
      if (!entity) continue;
      lines.push(
        `### ${session.nameOf(id)} (#${id})`,
        "",
        "```json",
        JSON.stringify(entity, null, 2),
        "```",
        "",
      );
    }
  }

  if (Object.keys(state.resources ?? {}).length > 0) {
    lines.push(
      "## Resources",
      "",
      "```json",
      JSON.stringify(state.resources, null, 2),
      "```",
      "",
    );
  }

  if (open.length > 0) {
    lines.push(`## Open comments (${open.length})`, "");
    for (const c of open) {
      const where = c.anchor.entity
        ? `${
          c.anchor.entityName ?? session.nameOf(c.anchor.entity)
        } (#${c.anchor.entity})`
        : c.anchor.point
        ? `point ${c.anchor.point.map((v) => v.toFixed(2)).join(", ")}`
        : "view";
      lines.push(
        `- **${where}**, ${c.anchor.mode} tick ${c.anchor.tick}: ${
          c.text.replace(/\n/g, " ")
        } — _${c.author}, ${c.created.slice(0, 16)}_ (id \`${c.id}\`)`,
      );
    }
    lines.push("");
  }

  if (status.kind === "error") {
    lines.push("## Build diagnostics", "", "```");
    for (const d of status.diagnostics) {
      lines.push(
        `${d.file}:${d.line}:${d.column}: ${d.code}: ${d.message}`,
        `    ${d.excerpt.trim()}`,
      );
    }
    lines.push("```", "");
  }

  if (recent.length > 0) {
    lines.push("## Console (latest last)", "", "```");
    for (const entry of recent.slice(-25)) {
      lines.push(
        `[${entry.mode} ${entry.tick}] ${entry.level} ${entry.source}: ${entry.text}`,
      );
    }
    lines.push("```", "");
  }

  lines.push(
    "## Reproduce",
    "",
    `- \`${dir}/state.scene.json\` is the world at this moment, in scene format (load it as a scene).`,
  );
  if (replay) {
    lines.push(
      `- \`${dir}/replay.json\` replays ticks ${replay.from}–${replay.to} exactly: a keyframe plus every input since.`,
    );
  }
  lines.push(
    `- See it: \`deno task ink capture ${project} --handoff ${id} --view handoff,game\``,
    `- Step it headlessly: \`deno task ink run ${project} --state ${dir}/state.scene.json --ticks 120\``,
    "",
  );

  const markdown = lines.join("\n");
  files.unshift({ name: "handoff.md", text: markdown });
  files.push({
    name: "handoff.json",
    text: json({
      id,
      note: options.note,
      scene: session.sceneName,
      mode: session.mode,
      paused: session.paused,
      tick: session.tick,
      selection: session.selection,
      view: options.view,
      replay,
    }),
  });
  return { id, files, markdown };
}
