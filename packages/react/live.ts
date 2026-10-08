/** Commands execute on the same Session and views used by the React editor. */
import {
  buildHandoff,
  type Comment,
  type CommentCapture,
  commentStatuses,
  replayHandoff,
} from "@ink/core";
import {
  type InputModel,
  type NamedNode,
  type Node,
  recordFromScene,
  type RecordValue,
} from "@ink/schema";
import { liveInteger, liveObject, liveString } from "@ink/dev/live";
import type { Ink } from "./context.tsx";
import { createAutomation } from "./automation.ts";

export function captureUrl(path: string): string {
  if (
    !/^\.ink\/captures\/[^/]+\/[^/]+\.png$/.test(path) || path.includes("..", 1)
  ) throw new Error("invalid capture path");
  return "/__ink/" +
    path.slice(".ink/".length).split("/").map(encodeURIComponent).join("/");
}

export async function saveHandoff(ink: Ink, note: string) {
  if (!ink.dev) throw new Error("handoffs need a dev connection");
  const handoff = buildHandoff(ink.session, {
    note,
    project: ink.project,
    view: ink.views.values().next().value?.pose() ?? undefined,
  });
  await ink.dev.client.postHandoff(handoff.files, handoff.id);
  return handoff.id;
}

export async function captureLive(
  ink: Ink,
  ready: Promise<void>,
  view?: string,
) {
  if (!ink.dev) throw new Error("captures need a dev connection");
  const session = ink.session;
  const resume = session.mode === "play" && !session.paused;
  session.pause();
  try {
    const mounted = view
      ? ink.views.get(view)
      : ink.views.values().next().value;
    const tick = session.tick;
    const packet = session.state;
    const state = session.toScene(session.current);
    let png: string;
    if (mounted) {
      // Let the viewport draw the latest stepped/edited state before readback.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      png = await mounted.capture();
    } else {
      if (
        view &&
        !["game", "iso", "top", "front", "side", "editor"].includes(view)
      ) throw new Error(`unknown view: ${view}`);
      png = (await createAutomation(ink, ready).capture({
        view,
        width: 960,
        height: 540,
      })).png;
    }
    const name = mounted?.id ?? view ?? "game";
    if (session.state !== packet) {
      throw new Error(
        "world changed during capture; retry from a paused state",
      );
    }
    const result = await ink.dev.client.postCapture([
      { name: "view.png", base64: png.split(",")[1] },
      { name: "state.scene.json", text: JSON.stringify(state) },
      {
        name: "view.json",
        text: JSON.stringify({ tick, view: name, camera: mounted?.pose() }),
      },
    ]);
    return { png, tick, view: name, path: `${result.dir}/view.png` };
  } finally {
    if (resume) session.resume();
  }
}

export function createLiveCommands(ink: Ink, ready: Promise<void>) {
  const session = ink.session;
  const world = () => ({
    state: session.toScene(session.current),
    mode: session.mode,
    paused: session.paused,
    scene: session.sceneName,
    selection: [...session.selection],
    status: session.status,
    views: [...ink.views.values()].map((v) => ({
      id: v.id,
      label: v.label,
      pose: v.pose(),
    })),
  });
  return async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    await ready;
    switch (method) {
      case "world":
        return world();
      case "edit": {
        if (params.tick !== undefined && params.tick !== session.tick) {
          throw new Error("world advanced; read it again before editing");
        }
        const resource = params.resource === undefined
          ? undefined
          : liveString(params.resource, "resource");
        const component = params.component === undefined
          ? undefined
          : liveString(params.component, "component");
        if (!!resource === !!component) {
          throw new Error("specify one component or resource");
        }
        const record = resource
          ? session.schema.resource(resource)
          : session.schema.component(component!);
        if (!record) {
          throw new Error(`unknown record: ${resource ?? component}`);
        }
        const id = component ? liveInteger(params.entity, "entity") : undefined;
        const current = resource
          ? session.world.resources[resource]
          : session.world.entities.find((e) => e.id === id)
            ?.components[component!];
        if (!current) {
          throw new Error("entity/component or resource does not exist");
        }
        const values = mergeFields(
          record.fields,
          current,
          liveObject(params.values),
        );
        const problems: string[] = [];
        const conformed = recordFromScene(
          session.schema,
          record,
          values,
          session.catalog,
          problems,
        );
        if (problems.length) throw new Error(problems.join("; "));
        const ok = session.edit(
          typeof params.label === "string"
            ? params.label
            : `Agent: edit ${record.name}`,
          (w) => {
            if (resource) w.resources[resource] = conformed;
            else {w.entities.find((e) => e.id === id)!.components[component!] =
                conformed;}
          },
        );
        if (!ok) throw new Error("edit rejected; see session log");
        return world();
      }
      case "play": {
        switch (params.action) {
          case "play":
            session.play();
            break;
          case "pause":
            session.pause();
            break;
          case "stop":
            session.stop();
            break;
          case "restart":
            session.restart();
            break;
          case "undo":
            session.undo();
            break;
          case "redo":
            session.redo();
            break;
          case "seek":
            session.seek(liveInteger(params.tick, "tick"));
            break;
          default:
            throw new Error("unknown play action");
        }
        return world();
      }
      case "step": {
        const inputs = params.inputs;
        if (inputs !== undefined && !Array.isArray(inputs)) {
          throw new Error("inputs must be an array");
        }
        const ticks = liveInteger(
          inputs?.length ?? params.ticks ?? 1,
          "ticks",
          36000,
        );
        if (inputs) {
          inputs.forEach((value, i) => {
            const input = liveObject(value);
            if (input.tick !== session.tick + i) {
              throw new Error(`invalid recorded input at ${i}`);
            }
            liveObject(input.actions);
            liveObject(input.pointer);
          });
        }
        if (!session.canStep) throw new Error("no runnable game is loaded");
        session.play();
        session.pause();
        for (let i = 0; i < ticks; i++) {
          const tick = session.tick;
          session.stepFrame(inputs?.[i] as InputModel | undefined);
          if (session.tick !== tick + 1) {
            throw new Error(`step failed at tick ${tick}`);
          }
        }
        return world();
      }
      case "capture":
        return await captureLive(
          ink,
          ready,
          params.view === undefined
            ? undefined
            : liveString(params.view, "view"),
        );
      case "comments":
        return session.comments.filter((c) =>
          (params.status === "all" ||
            (params.status
              ? c.status === params.status
              : c.status !== "resolved")) &&
          (params.assignee === undefined ||
            (c.assignee ?? "") === params.assignee)
        );
      case "comment": {
        const status = params.status;
        if (
          status !== undefined &&
          !commentStatuses.includes(status as Comment["status"])
        ) throw new Error("unknown comment status");
        const author = params.author === undefined
          ? "agent"
          : liveString(params.author, "author");
        if (params.action === "add") {
          const text = liveString(params.text, "text");
          const anchor = params.anchor === undefined
            ? {}
            : liveObject(params.anchor);
          const comment = session.addComment({
            author,
            text,
            status: status as Comment["status"] | undefined,
            assignee: typeof params.assignee === "string"
              ? params.assignee
              : undefined,
            anchor: validateAnchor({
              mode: session.mode,
              tick: session.tick,
              scene: session.sceneName,
              ...anchor,
            }),
            handoff: params.handoff === undefined
              ? await saveHandoff(ink, text)
              : liveString(params.handoff, "handoff"),
          });
          await ink.dev?.flushComments();
          return comment;
        }
        const id = liveString(params.id, "id");
        if (!session.comments.some((c) => c.id === id)) {
          throw new Error(`no comment ${id}`);
        }
        if (params.action === "reply") {
          const captures = params.captures === undefined
            ? undefined
            : validateCaptures(params.captures);
          session.replyToComment(id, {
            author,
            text: liveString(params.text, "text"),
            created: new Date().toISOString(),
            captures,
          });
        } else if (params.action === "update") {
          const patch: Partial<Comment> = {};
          if (status) patch.status = status as Comment["status"];
          if (params.assignee !== undefined) {
            if (typeof params.assignee !== "string") {
              throw new Error("assignee must be a string");
            }
            patch.assignee = params.assignee;
          }
          if (params.text !== undefined) {
            patch.text = liveString(params.text, "text");
          }
          if (params.handoff !== undefined) {
            patch.handoff = liveString(params.handoff, "handoff");
          }
          session.updateComment(id, patch);
        } else throw new Error("unknown comment action");
        await ink.dev?.flushComments();
        return session.comments.find((c) => c.id === id);
      }
      case "handoff": {
        if (!ink.dev) throw new Error("handoffs need a dev connection");
        if (params.action === "create") {
          return {
            id: await saveHandoff(
              ink,
              typeof params.note === "string" ? params.note : "Agent handoff",
            ),
          };
        }
        const id = liveString(params.id, "id");
        const file = async (name: string) =>
          (await ink.dev!.client.handoffFile(id, name)).json();
        if (params.action === "replay") {
          replayHandoff(session, await file("replay.json"), `handoff ${id}`);
        } else if (params.action === "open") {
          session.loadScene(await file("state.scene.json"), `handoff ${id}`);
          const info = await file("handoff.json");
          if (info.mode === "play") {
            session.play({ start: false });
            session.pause();
          }
          for (const frame of info.events ?? []) {
            session.timeline.events.record(frame.tick, frame.events);
          }
          if (Array.isArray(info.selection)) session.select(info.selection);
        } else throw new Error("unknown handoff action");
        return world();
      }
      default:
        throw new Error(`unknown browser command: ${method}`);
    }
  };
}

function validateAnchor(value: Record<string, unknown>): Comment["anchor"] {
  if (value.mode !== "edit" && value.mode !== "play") {
    throw new Error("invalid comment mode");
  }
  liveInteger(value.tick, "tick");
  if (value.range) {
    const range = liveObject(value.range);
    if (liveInteger(range.from, "from") > liveInteger(range.to, "to")) {
      throw new Error("invalid timeline range");
    }
  }
  if (value.code) {
    const code = liveObject(value.code);
    liveString(code.file, "file");
    if (liveInteger(code.line, "line") < 1) {
      throw new Error("line must be positive");
    }
  }
  return value as unknown as Comment["anchor"];
}

function validateCaptures(value: unknown): CommentCapture[] {
  if (!Array.isArray(value)) throw new Error("captures must be an array");
  return value.map((v) => {
    const c = liveObject(v);
    if (!["before", "after", "evidence"].includes(String(c.label))) {
      throw new Error("invalid capture label");
    }
    captureUrl(liveString(c.path, "path"));
    liveInteger(c.tick, "tick");
    return c as unknown as CommentCapture;
  });
}

function mergeFields(
  fields: NamedNode[],
  current: RecordValue,
  values: Record<string, unknown>,
): RecordValue {
  const merged = { ...current };
  for (const [key, value] of Object.entries(values)) {
    const field = fields.find((f) => f.name === key);
    if (!field) throw new Error(`unknown field: ${key}`);
    merged[key] = validateValue(
      field.node,
      current[key],
      value,
    ) as RecordValue[string];
  }
  return merged;
}

function validateValue(node: Node, current: unknown, value: unknown): unknown {
  if (node.kind === "struct") {
    return mergeFields(
      node.fields,
      (current ?? {}) as RecordValue,
      liveObject(value),
    );
  }
  if (node.kind === "list") {
    if (!Array.isArray(value)) throw new Error("expected a list");
    return value.map((v) => validateValue(node.element, undefined, v));
  }
  if (node.kind === "bool" && typeof value === "boolean") return value;
  if (
    node.kind === "enum" && typeof value === "string" &&
    node.values.includes(value)
  ) return value;
  if (
    (node.kind === "asset" || node.kind === "message") &&
    typeof value === "string"
  ) return value;
  if (
    ["vec2", "vec3", "vec4", "quat", "color"].includes(node.kind) &&
    Array.isArray(value) && value.length === node.lanes &&
    value.every((v) => typeof v === "number" && Number.isFinite(v))
  ) return value;
  if (
    node.kind === "f32" && typeof value === "number" &&
    Number.isFinite(Math.fround(value))
  ) return value;
  if (["u32", "entity", "asset", "message"].includes(node.kind)) {
    return liveInteger(
      value,
      node.kind,
      node.kind === "u32" ? 0xffffffff : 0xffffff,
    );
  }
  throw new Error(`invalid ${node.kind} value`);
}
