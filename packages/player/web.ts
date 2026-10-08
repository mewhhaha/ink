import { loadGame } from "@ink/blot";
import { describeAction, keyLabel } from "@ink/core/input";
import {
  type Camera,
  createRenderer,
  extractScene,
  gameCamera,
  lookAtCamera,
} from "@ink/render";
import type { Catalog, SceneFile, Schema } from "@ink/schema";
import { mat4, rayFromNdc } from "@ink/geometry";
import { Player } from "./runtime.ts";
import { pollGamepad } from "./devices.ts";
import { connectAudio } from "./audio.ts";
import "./style.css";

export interface PlayerOptions {
  title: string;
  schema: Schema;
  catalog: Catalog;
  scene: string;
  wasm: string;
  assetBase: string;
  tickRate?: number;
  pointerLock?: boolean;
  stats?: { label: string; resource: string; field: string }[];
}

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (className) e.className = className;
  return e;
};
const button = (label: string, click: () => void) => {
  const b = element("button", label);
  b.type = "button";
  b.addEventListener("click", click);
  return b;
};

export async function bootPlayer(options: PlayerOptions) {
  document.title = options.title;
  const root = element("main", undefined, "ink-player");
  const canvas = element("canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", options.title);
  const loading = element("p", "Loading…", "player-loading");
  root.append(canvas, loading);
  document.body.replaceChildren(root);
  const fetchOk = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not load ${url} (${response.status})`);
    }
    return response;
  };
  try {
    const [scene, bytes, renderer] = await Promise.all([
      fetchOk(options.scene).then((r) => r.json() as Promise<SceneFile>),
      fetchOk(options.wasm).then((r) => r.arrayBuffer()).then((b) =>
        new Uint8Array(b)
      ),
      createRenderer({ assetBase: options.assetBase }),
    ]);
    const player = new Player(
      options.schema,
      options.catalog,
      await loadGame(bytes, options.schema),
      scene,
      options.tickRate,
    );
    player.paused = true;
    const view = renderer.createView(canvas);
    const bindingsKey = `ink:controls:${location.pathname}`;
    try {
      const bindings = JSON.parse(localStorage.getItem(bindingsKey) ?? "{}");
      for (const { name, action } of options.schema.actions) {
        const record = bindings[name];
        if (!record || record.kind !== action.kind) continue;
        for (const [slot, keys] of Object.entries(record)) {
          if (Array.isArray(keys) && keys.every((k) => typeof k === "string")) {
            player.input.bind(name, slot, keys);
          }
        }
      }
    } catch { /* Defaults survive corrupt or unavailable storage. */ }
    const listeners = new AbortController();
    const signal = listeners.signal;
    let camera: Camera;
    let stopped = false;
    let frame = 0;
    let previous = performance.now();
    let pads = new Set<string>();
    let captured:
      | { action: string; slot: string; button: HTMLButtonElement }
      | null = null;
    let started = false;
    const modal = element("dialog");
    modal.setAttribute("aria-label", "Game menu");
    const title = element("h1", options.title);
    const controls = element("div", undefined, "player-bindings");
    const status = element("p", "Keyboard, gamepad and touch supported.");
    const save = () => {
      try {
        localStorage.setItem(
          bindingsKey,
          JSON.stringify(player.input.bindings),
        );
      } catch { /* Still usable without persistence. */ }
    };
    const finishBinding = (code: string) => {
      if (!captured) return;
      const binding = player.input.binding(
        captured.action,
      ) as unknown as Record<string, string[]>;
      const otherDevice = code
        ? binding[captured.slot].filter((key) =>
          key.startsWith("Pad") !== code.startsWith("Pad")
        )
        : [];
      player.input.bind(
        captured.action,
        captured.slot,
        code ? [...otherDevice, code] : [],
      );
      captured = null;
      save();
      showBindings();
    };
    const showBindings = () => {
      controls.replaceChildren();
      for (const { name } of options.schema.actions) {
        const action = player.input.binding(name);
        const group = element("fieldset");
        group.append(element("legend", name.replaceAll("_", " ")));
        const slots = action.kind === "button"
          ? ["keys"]
          : action.kind === "axis"
          ? ["negative", "positive"]
          : ["left", "right", "up", "down"];
        for (const slot of slots) {
          const row = element(
            "label",
            ({
              keys: "Press",
              negative: "Left",
              positive: "Right",
              left: "Left",
              right: "Right",
              up: "Up",
              down: "Down",
            } as Record<string, string>)[slot],
          );
          const keys = (action as unknown as Record<string, string[]>)[slot];
          const b = button(keys.map(keyLabel).join(" / ") || "Unbound", () => {
            captured = { action: name, slot, button: b };
            b.textContent = "Press a key or gamepad button…";
          });
          b.setAttribute("aria-label", `Bind ${name} ${slot}`);
          row.append(b);
          group.append(row);
        }
        controls.append(group);
      }
      hint.textContent = options.schema.actions.map(({ name }) =>
        `${name}: ${describeAction(player.input.binding(name))}`
      ).join(" · ");
    };
    const playButton = button("Play", () => {
      started = true;
      captured = null;
      modal.close();
      player.paused = false;
      previous = performance.now();
      playButton.textContent = "Resume";
      canvas.focus();
      if (options.pointerLock && !matchMedia("(pointer: coarse)").matches) {
        canvas.requestPointerLock()?.catch(() => {});
      }
    });
    const openMenu = () => {
      player.paused = true;
      player.input.releaseAll();
      captured = null;
      document.exitPointerLock?.();
      showBindings();
      if (!modal.open) modal.showModal();
    };
    modal.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (started) playButton.click();
    });
    const reset = button("Reset controls", () => {
      player.input.bindings = {};
      save();
      showBindings();
    });
    const restart = button("Restart", () => {
      player.restart();
      playButton.click();
    });
    modal.append(title, playButton, restart, status, controls, reset);
    const bar = element("header", undefined, "player-bar");
    const hud = element("div", undefined, "player-stats");
    bar.append(
      element("strong", options.title),
      hud,
      button("Controls", openMenu),
    );
    const hint = element(
      "p",
      options.schema.actions.map(({ name, action }) =>
        `${name}: ${describeAction(action)}`
      ).join(" · "),
      "player-hint",
    );
    const notice = element("p", undefined, "player-notice");
    notice.setAttribute("aria-live", "polite");
    root.append(bar, hint, notice, modal);
    if (options.pointerLock) {
      root.append(element("span", "+", "player-crosshair"));
    }
    let noticeUntil = 0;
    const offMessages = player.onEvents((events) => {
      for (const e of events) {
        if (e.name !== "log") continue;
        const message = options.schema.messages.find((m) =>
          m.id === e.value.message
        );
        if (!message) continue;
        notice.textContent = message.text.replace(
          /\{(\d+)\}/g,
          (_, i) => String([e.value.a, e.value.b][Number(i)] ?? ""),
        );
        noticeUntil = performance.now() + 4000;
      }
    });
    const offAudio = connectAudio(
      player,
      (path) => new URL(path, options.assetBase).href,
      () =>
        camera
          ? {
            position: camera.position,
            right: [camera.view[0], camera.view[4], camera.view[8]],
          }
          : null,
    );
    const focused = () => document.activeElement === canvas && !player.paused;
    addEventListener("keydown", (event) => {
      if (captured) {
        event.preventDefault();
        if (event.code === "Escape") {
          captured = null;
          showBindings();
        } else if (
          ![
            "ControlLeft",
            "ControlRight",
            "MetaLeft",
            "MetaRight",
            "AltLeft",
            "AltRight",
            "ShiftLeft",
            "ShiftRight",
          ].includes(event.code)
        ) finishBinding(event.code === "Backspace" ? "" : event.code);
        return;
      }
      if (event.code === "Escape" && !modal.open) {
        event.preventDefault();
        openMenu();
        return;
      }
      if (!focused()) return;
      event.preventDefault();
      player.input.keyDown(event.code);
    }, { signal });
    addEventListener("keyup", (event) => player.input.keyUp(event.code), {
      signal,
    });
    addEventListener("blur", () => {
      if (started && !stopped) openMenu();
    }, { signal });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && started) openMenu();
    }, { signal });
    document.addEventListener("pointerlockchange", () => {
      if (
        started && options.pointerLock && !document.pointerLockElement &&
        !modal.open
      ) openMenu();
    }, { signal });
    const mouseCode = (index: number) =>
      ["MouseLeft", "MouseMiddle", "MouseRight"][index] ?? `Mouse${index}`;
    canvas.addEventListener("contextmenu", (event) => event.preventDefault(), {
      signal,
    });
    canvas.addEventListener("pointerdown", (event) => {
      canvas.focus();
      player.input.keyDown(mouseCode(event.button));
      if (
        options.pointerLock && event.pointerType === "mouse" &&
        !document.pointerLockElement
      ) canvas.requestPointerLock()?.catch(() => {});
    }, { signal });
    addEventListener(
      "pointerup",
      (event) => player.input.keyUp(mouseCode(event.button)),
      { signal },
    );
    canvas.addEventListener("pointermove", (event) => {
      if (player.paused || !camera) return;
      const locked = document.pointerLockElement === canvas;
      const rect = canvas.getBoundingClientRect();
      const position: [number, number] = locked ? [0, 0] : [
        (event.clientX - rect.left) / rect.width * 2 - 1,
        1 - (event.clientY - rect.top) / rect.height * 2,
      ];
      const ray = rayFromNdc(
        mat4.invert(mat4.multiply(camera.projection, camera.view)),
        position,
      );
      player.input.pointer({ position, inside: true, locked, ray });
      if (locked || event.pointerType === "touch") {
        player.input.pointerMove(event.movementX, event.movementY);
      }
    }, { signal });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      player.input.wheel(event.deltaY);
    }, { signal, passive: false });
    const touch = element("nav", undefined, "player-touch");
    touch.setAttribute("aria-label", "Touch controls");
    const moveAction = options.schema.actions.find((a) => a.name === "move") ??
      options.schema.actions.find((a) => a.action.kind !== "button");
    if (moveAction) {
      const stick = element("div", "Move", "player-stick");
      stick.setAttribute("aria-label", "Movement stick");
      let pointer: number | null = null;
      const change = (event: PointerEvent) => {
        const r = stick.getBoundingClientRect();
        const x = Math.max(
          -1,
          Math.min(1, (event.clientX - r.x - r.width / 2) / (r.width * 0.4)),
        );
        const y = Math.max(
          -1,
          Math.min(1, (r.y + r.height / 2 - event.clientY) / (r.height * 0.4)),
        );
        player.input.device("touch", {
          [moveAction.name]: moveAction.action.kind === "axis" ? x : [x, y],
        });
      };
      stick.addEventListener("pointerdown", (event) => {
        pointer = event.pointerId;
        stick.setPointerCapture(pointer);
        change(event);
      });
      stick.addEventListener("pointermove", (event) => {
        if (pointer === event.pointerId) change(event);
      });
      const release = () => {
        pointer = null;
        player.input.device("touch", null);
      };
      stick.addEventListener("pointerup", release);
      stick.addEventListener("lostpointercapture", release);
      touch.append(stick);
    }
    const actions = element("div", undefined, "player-touch-buttons");
    for (const { name, action } of options.schema.actions) {
      if (action.kind !== "button") continue;
      const b = element("button", name);
      b.setAttribute("aria-label", `Touch ${name}`);
      b.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        b.setPointerCapture(event.pointerId);
        player.input.hold(name, true);
      });
      b.addEventListener("pointerup", () => player.input.hold(name, false));
      b.addEventListener(
        "lostpointercapture",
        () => player.input.hold(name, false),
      );
      actions.append(b);
    }
    touch.append(actions);
    root.append(touch);
    const render = () => {
      const width = Math.max(
        1,
        Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 2)),
      );
      const height = Math.max(
        1,
        Math.round(canvas.clientHeight * Math.min(devicePixelRatio, 2)),
      );
      if (canvas.width !== width || canvas.height !== height) {
        view.resize(width, height, 1);
      }
      player.input.viewport = [width, height];
      const scene = extractScene(player.world, player.catalog);
      camera = gameCamera(scene, width / height) ??
        lookAtCamera([8, 6, 8], [0, 0, 0], {}, width / height);
      view.render(scene, camera);
      hud.replaceChildren(...(options.stats ?? []).map((stat) => {
        const value = player.world.resources[stat.resource]?.[stat.field];
        return element(
          "span",
          `${stat.label} ${
            typeof value === "number"
              ? Math.round(value * 10) / 10
              : value === true
              ? "✓"
              : value === false
              ? "—"
              : value ?? ""
          }`,
        );
      }));
    };
    render();
    await renderer.assets.settled();
    render();
    await renderer.device.queue.onSubmittedWorkDone();
    loading.remove();
    openMenu();
    const loop = (now: number) => {
      if (stopped) return;
      const elapsed = Math.min(0.1, (now - previous) / 1000);
      previous = now;
      try {
        const pad = navigator.getGamepads?.().find((p) => p?.connected) ?? null;
        if (captured && pad) {
          const index = pad.buttons.findIndex((b) => b.pressed);
          if (index >= 0) finishBinding(`PadButton${index}`);
        }
        if (!player.paused) {
          pads = pollGamepad(player.input, pad, pads);
          if (
            options.pointerLock && !options.schema.actions.some((a) =>
              a.name === "turn" || a.name === "look"
            ) && pad
          ) {
            const axis = (i: number) =>
              Math.abs(pad.axes[i] ?? 0) > 0.15 ? pad.axes[i] : 0;
            player.input.pointerMove(
              axis(2) * elapsed * 500,
              axis(3) * elapsed * 500,
            );
          }
          player.advance(elapsed);
        } else pads = pollGamepad(player.input, null, pads);
        render();
        if (now > noticeUntil) notice.textContent = "";
      } catch (error) {
        openMenu();
        status.textContent = String(error);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    const dispose = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      listeners.abort();
      offAudio();
      offMessages();
      player.dispose();
      renderer.dispose();
    };
    addEventListener("pagehide", dispose, { once: true, signal });
    return { player, renderer, view, dispose, readyMs: performance.now() };
  } catch (error) {
    loading.textContent = `Could not start: ${
      error instanceof Error ? error.message : error
    }`;
    throw error;
  }
}
