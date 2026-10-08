/**
 * `window.__ink`: what `deno task ink capture` and other tools drive in a
 * headless browser. Installed when the page URL has `?ink-automation`.
 * Captures render offscreen at an exact size from a named view, so the same
 * state always gives the same picture.
 */
import { mat4, type Quat, type Vec3 } from "@ink/geometry";
import { type Camera, cameraFromMatrix, gameCamera } from "@ink/render";
import { type CameraPose, MultiplayerPlay, runScenario } from "@ink/core";
import type { SceneFile } from "@ink/schema";
import type {
  CaptureOptions,
  InkAutomation,
  RunOptions,
} from "@ink/dev/automation";
import type { Ink } from "./context.tsx";
import {
  defaultCamera,
  frame,
  isoCamera,
  renderCamera,
  type ViewKind,
} from "./cameras.ts";
import { blobToDataUrl } from "./viewport.tsx";
import { compareImages } from "./image_diff.ts";

export function poseCamera(pose: CameraPose, aspect: number): Camera {
  return cameraFromMatrix(
    mat4.compose(pose.position as Vec3, pose.rotation as Quat, [1, 1, 1]),
    {
      fov: pose.fov,
      near: pose.orthographic ? 1 : 0.05,
      far: pose.orthographic ? 2000 : 2000,
      orthographic: pose.orthographic ?? false,
      size: pose.size ?? 10,
    },
    aspect,
  );
}

export function createAutomation(
  ink: Ink,
  ready: Promise<void>,
): InkAutomation {
  const { session } = ink;

  const load = async (
    options: { scene?: string; state?: SceneFile; handoff?: string },
  ): Promise<CameraPose | undefined> => {
    if (!options.state && !options.handoff && !options.scene) return undefined;
    if (session.mode === "play") session.stop();
    if (options.state) {
      session.loadScene(options.state, "automation");
    } else if (options.handoff && ink.dev) {
      const state = await (await ink.dev.client.handoffFile(
        options.handoff,
        "state.scene.json",
      )).json();
      session.loadScene(state, `handoff ${options.handoff}`);
      try {
        const info = await (await ink.dev.client.handoffFile(
          options.handoff,
          "handoff.json",
        )).json();
        if (info.mode === "play") {
          session.play({ start: false });
          session.pause();
        }
        for (const frame of info.events ?? []) {
          session.timeline.events.record(frame.tick, frame.events);
        }
        return info.view;
      } catch {
        return undefined;
      }
    } else if (options.scene && ink.dev) {
      session.loadScene(
        await ink.dev.client.scene(options.scene),
        options.scene,
      );
    }
    return undefined;
  };

  const runTicks = (ticks: number) => {
    if (ticks <= 0) return;
    session.play();
    for (let i = 0; i < ticks; i++) session.stepFrame();
  };

  const settle = async () => {
    const assets = ink.renderer?.assets as
      | { settled?: () => Promise<void> }
      | undefined;
    if (assets?.settled) await assets.settled();
    else await new Promise((r) => setTimeout(r, 400));
  };

  const automation: InkAutomation = {
    ready,
    network(tick) {
      const play = session.driver;
      if (!(play instanceof MultiplayerPlay)) return null;
      return {
        ...play.status,
        hash: play.rollback?.hash(tick),
        state: tick === undefined
          ? undefined
          : Array.from(play.rollback!.snapshot(tick)),
      };
    },
    async capture(options: CaptureOptions) {
      await ready;
      const renderer = ink.renderer;
      if (!renderer) throw new Error("WebGPU is unavailable in this browser");
      const handoffView = await load(options);
      runTicks(options.ticks ?? 0);
      const width = options.width ?? 1280;
      const height = options.height ?? 720;
      const aspect = width / height;
      const name = options.view ?? (handoffView ? "handoff" : "game");
      const tick = session.tick;
      const view = renderer.createView({ width, height });
      try {
        // Render once so the scene's assets start loading, then wait for them.
        const scene = ink.scene();
        const cameraFor = (): {
          camera: Camera;
          describe: unknown;
          grid: boolean;
        } => {
          if (name === "handoff" && handoffView) {
            return {
              camera: poseCamera(handoffView, aspect),
              describe: handoffView,
              grid: !!handoffView.view && handoffView.view !== "game",
            };
          }
          if (name === "game") {
            const game = gameCamera(scene, aspect);
            if (game) {
              return { camera: game, describe: { view: "game" }, grid: false };
            }
          }
          if (name === "top" || name === "front" || name === "side") {
            const editor = scene.bounds
              ? frame(defaultCamera(name as ViewKind), scene.bounds, aspect)
              : defaultCamera(name as ViewKind);
            return {
              camera: renderCamera(editor, aspect),
              describe: editor,
              grid: true,
            };
          }
          if (name === "editor") {
            try {
              const stored = JSON.parse(
                localStorage.getItem(`ink:camera:${location.pathname}:main`) ??
                  "null",
              );
              if (stored?.kind === "perspective") {
                return {
                  camera: renderCamera(stored, aspect),
                  describe: stored,
                  grid: true,
                };
              }
            } catch {
              // fall through to iso
            }
          }
          const iso = isoCamera(scene.bounds, aspect);
          return {
            camera: renderCamera(iso, aspect),
            describe: { ...iso, view: name },
            grid: name !== "game",
          };
        };
        let chosen = cameraFor();
        const overlays = () => ({
          grid: chosen.grid
            ? {
              plane: name === "front"
                ? "xy" as const
                : name === "side"
                ? "yz" as const
                : "xz" as const,
              spacing: 1,
              major: 10,
            }
            : false as const,
          edges: chosen.grid,
          shading: (name === "top" || name === "front" || name === "side"
            ? "unlit"
            : "lit") as "lit" | "unlit",
          quality: options.quality,
          still: true,
        });
        view.render(scene, chosen.camera, overlays());
        await settle();
        chosen = cameraFor();
        view.render(scene, chosen.camera, overlays());
        const png = await blobToDataUrl(await view.capture());
        return {
          png,
          tick,
          view: {
            name,
            width,
            height,
            camera: chosen.describe,
            stats: { ...view.stats },
          },
        };
      } finally {
        view.dispose();
      }
    },
    async run(options: RunOptions) {
      await ready;
      await load(options);
      if (options.inputs) {
        session.play();
        session.pause();
        for (const input of options.inputs) {
          const tick = session.tick;
          session.stepFrame(input);
          if (session.tick !== tick + 1) {
            throw new Error(`game failed at tick ${tick}`);
          }
        }
      } else runTicks(options.ticks ?? 0);
      return session.toScene(session.current);
    },
    state: () => session.toScene(session.current),
    async scenario({ scenario, updateGoldens }) {
      await ready;
      await load({
        scene: scenario.scene ?? (!scenario.state ? "main" : undefined),
        state: scenario.state,
      });
      return await runScenario(session, scenario, async (spec) => {
        const { png } = await automation.capture({
          view: spec.view ?? "game",
          width: spec.width ?? 320,
          height: spec.height ?? 180,
        });
        if (updateGoldens) return { png, error: 0 };
        if (!ink.dev) {
          throw new Error("scenario goldens need a project connection");
        }
        return {
          png,
          ...await compareImages(
            png,
            ink.dev.client.scenarioFileUrl(spec.golden),
          ),
        };
      });
    },
  };
  return automation;
}

export function installAutomation(ink: Ink, ready: Promise<void>) {
  const automation = createAutomation(ink, ready);
  (globalThis as unknown as { __ink: InkAutomation }).__ink = automation;
}
