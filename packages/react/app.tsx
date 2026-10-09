/**
 * `<InkApp>` boots a project (dev server, session, game, renderer), provides
 * the Ink context, runs the frame loop and hotkeys, and flips between the
 * editor layout you compose and the game alone. Boot state lives outside
 * React, so hot reloading the app's own components keeps the running game.
 */
import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createRenderer, type Renderer } from "@ink/render";
import type { Session } from "@ink/core";
import { quat } from "@ink/geometry";
import {
  FrameLoop,
  type Ink,
  InkContext,
  sceneCache,
  useInk,
  useSessionValue,
  useUi,
} from "./context.tsx";
import { type DevConnection, startDev } from "./dev.ts";
import { defaultUi, Store, type UiState } from "./store.ts";
import {
  builtinCommands,
  type Command,
  commandShortcuts,
  matchShortcut,
} from "./commands.ts";
import { MenuProvider } from "./menu.tsx";
import { HandoffDialog } from "./handoff.tsx";
import { CommandPalette } from "./palette.tsx";
import type { Preset } from "./outliner.tsx";
import { Viewport, type ViewportTool } from "./viewport.tsx";
import { Inspector } from "./inspector.tsx";
import {
  CollaborateButtons,
  LayoutButton,
  PlayControls,
  ToolButton,
} from "./toolbar.tsx";
import { installAutomation } from "./automation.ts";
import { createLiveCommands } from "./live.ts";
import { CommentQueue } from "./comments.tsx";
import { HistoryWindow } from "./history.tsx";
import { ShortcutSettings } from "./shortcuts.tsx";
import { connectAudio } from "./audio.ts";
import { Icon } from "./icons.tsx";

interface Boot {
  session: Session;
  dev: DevConnection;
  renderer: Renderer | null;
  rendererError: string | null;
  loop: FrameLoop;
  ui: Store<UiState>;
  ink: Ink;
  listeners: Set<() => void>;
}

const BOOT = Symbol.for("ink.boot");
type Global = { [BOOT]?: Promise<Boot> };

function boot(
  options: {
    project: string;
    title: string;
    tickRate?: number;
    ui?: Partial<UiState>;
  },
): Promise<Boot> {
  const global = globalThis as Global;
  global[BOOT] ??= (async () => {
    const { session, dev } = await startDev({ tickRate: options.tickRate });
    const ui = new Store<UiState>(
      { ...defaultUi, ...options.ui },
      `ink:ui:${location.pathname}`,
    );
    ui.set({ palette: false, handoff: false });
    const loop = new FrameLoop(session);
    const views = new Map();
    const listeners = new Set<() => void>();
    const state: Boot = {
      session,
      dev,
      renderer: null,
      rendererError: null,
      loop,
      ui,
      listeners,
      ink: {
        session,
        renderer: null,
        ui,
        loop,
        views,
        dev,
        project: options.project,
        title: options.title,
        scene: sceneCache(
          session,
          () => state.renderer?.assets,
          () => ui.get().hidden,
        ),
      },
    };
    loop.start();
    createRenderer({ assetBase: dev.client.assetUrl("") }).then((renderer) => {
      state.renderer = renderer;
      loop.device = renderer.device;
      session.profiler.gpuTimestamps = renderer.device.features.has(
        "timestamp-query",
      );
      state.ink = { ...state.ink, renderer };
      dev.attachRenderer(renderer);
      renderer.lost.then((info) =>
        session.error(`GPU device lost: ${info.message}`)
      );
      for (const listener of listeners) listener();
    }).catch((error) => {
      state.rendererError = String(error?.message ?? error);
      session.error(`WebGPU unavailable: ${state.rendererError}`);
      for (const listener of listeners) listener();
    });
    connectAudio(session, (path) => dev.client.assetUrl(path), () => {
      const pose = views.get("main")?.pose() ?? views.get("game")?.pose();
      if (!pose) return null;
      return {
        position: pose.position as [number, number, number],
        right: quat.rotate(pose.rotation as never, [1, 0, 0]) as [
          number,
          number,
          number,
        ],
      };
    });
    const ready = new Promise<void>((resolve) => {
      const check = () => {
        if (
          (state.renderer || state.rendererError) &&
          session.status.kind !== "building"
        ) {
          listeners.delete(check);
          off();
          resolve();
        }
      };
      listeners.add(check);
      const off = session.subscribe(check);
      check();
    });
    const proxy = new Proxy({} as Ink, {
      get: (_, key) => state.ink[key as keyof Ink],
    });
    dev.client.connectLive({
      id: crypto.randomUUID(),
      title: options.title,
      url: location.href,
    }, createLiveCommands(proxy, ready));
    if (new URLSearchParams(location.search).has("ink-automation")) {
      installAutomation(proxy, ready);
    }
    return state;
  })();
  return global[BOOT]!;
}

export interface InkAppProps {
  /** Project path relative to the workspace, used in hand-off commands. */
  project: string;
  title?: string;
  /** The editor layout. */
  children: ReactNode;
  /** In-game UI drawn over the game view when the app is flipped to the game. */
  hud?: ReactNode;
  tools?: ViewportTool[];
  commands?: Command[];
  presets?: Preset[];
  tickRate?: number;
  /** Initial UI state (tool, grid size, ...). */
  ui?: Partial<UiState>;
  /** Lock the pointer in the game view while playing (first-person games). */
  pointerLock?: boolean;
}

export function InkApp(props: InkAppProps) {
  const [state, setState] = useState<Boot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    boot({
      project: props.project,
      title: props.title ?? props.project,
      tickRate: props.tickRate,
      ui: props.ui,
    })
      .then((s) => alive && setState(s))
      .catch((e) => alive && setError(String(e?.stack ?? e)));
    return () => {
      alive = false;
    };
  }, []);
  // Re-render when the renderer arrives.
  const version = useSyncExternalStore(
    (listener) => {
      state?.listeners.add(listener);
      return () => state?.listeners.delete(listener);
    },
    () => (state ? `${!!state.renderer}${state.rendererError}` : ""),
  );
  const ink = useMemo(
    () => (state
      ? { ...state.ink, title: props.title ?? state.ink.title }
      : null),
    [state, version, props.title],
  );

  if (error) {
    return (
      <div className="ink-loading ink-root">
        <Icon name="alert" size={24} style={{ color: "var(--ink-danger)" }} />
        <div>Ink could not start</div>
        <pre
          style={{
            maxWidth: "80vw",
            whiteSpace: "pre-wrap",
            color: "var(--ink-muted)",
          }}
        >{error}</pre>
      </div>
    );
  }
  if (!ink) {
    return (
      <div className="ink-loading ink-root">
        <span
          className="ink-brand-mark"
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            animation: "ink-pulse 0.8s infinite alternate",
          }}
        />
        <div>Loading {props.title ?? props.project}…</div>
      </div>
    );
  }
  return (
    <InkContext.Provider value={ink}>
      <MenuProvider>
        <Shell {...props} />
      </MenuProvider>
    </InkContext.Provider>
  );
}

function Shell(props: InkAppProps) {
  const ink = useInk();
  const layout = useUi((u) => u.layout);
  const playing = useSessionValue((s) => s.mode === "play");
  const overrides = useUi((u) => u.shortcuts);
  const defaults = useMemo(
    () => [
      ...builtinCommands,
      ...(props.commands ?? []),
      ...toolCommands(props.tools ?? []),
    ],
    [props.commands, props.tools],
  );
  const commands = useMemo(
    () =>
      defaults.map((c) => ({ ...c, shortcut: commandShortcuts(c, overrides) })),
    [defaults, overrides],
  );
  useHotkeys(commands);
  useEffect(() => {
    document.title = `${ink.session.dirty ? "● " : ""}${ink.title}`;
    return ink.session.subscribe(() => {
      document.title = `${ink.session.dirty ? "● " : ""}${ink.title}`;
    });
  }, [ink.title]);
  return (
    <div className="ink-root" data-playing={playing}>
      {layout === "game"
        ? <GameLayout hud={props.hud} pointerLock={props.pointerLock} />
        : props.children}
      <HandoffDialog />
      <CommentQueue />
      <HistoryWindow />
      <ShortcutSettings commands={defaults} />
      <CommandPalette commands={commands} presets={props.presets} />
    </div>
  );
}

function toolCommands(tools: ViewportTool[]): Command[] {
  return tools.map((tool) => ({
    id: `tool-${tool.id}`,
    label: `${tool.label} tool`,
    icon: tool.icon,
    shortcut: tool.shortcut,
    group: "Tools",
    run: ({ ui }) => ui.set({ tool: tool.id as never }),
  }));
}

function useHotkeys(commands: Command[]) {
  const ink = useInk();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      for (const command of commands) {
        const shortcuts = Array.isArray(command.shortcut)
          ? command.shortcut
          : command.shortcut
          ? [command.shortcut]
          : [];
        if (!shortcuts.some((s) => matchShortcut(event, s))) continue;
        if (typing && !command.global) return;
        if (command.enabled && !command.enabled(ink)) return;
        event.preventDefault();
        command.run(ink);
        return;
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [commands, ink]);
}

/** The game alone, full window: a dock to get back, comment and hand off;
 * pause and click something to inspect and change it in place. */
function GameLayout(props: { hud?: ReactNode; pointerLock?: boolean }) {
  const ink = useInk();
  const { mode, paused, selected } = useSessionValue(
    (s) => ({
      mode: s.mode,
      paused: s.paused,
      selected: s.selection.length > 0,
    }),
    (a, b) =>
      a.mode === b.mode && a.paused === b.paused && a.selected === b.selected,
  );
  const showInspector = (mode === "edit" || paused) && selected;
  return (
    <div className="ink-game-layout">
      <Viewport
        id="game-full"
        view="game"
        switcher={false}
        label=""
        diagnostics
        pointerLock={props.pointerLock}
        style={{ borderRadius: 0 }}
      >
        {props.hud}
      </Viewport>
      <div className="ink-game-dock" data-visible={mode !== "play" || paused}>
        <PlayControls />
        <CollaborateButtons />
        <LayoutButton />
        {paused && (
          <ToolButton
            icon="check"
            label="Apply play changes to the scene"
            onClick={() =>
              ink.session.applyToDocument(
                ink.session.selection.length
                  ? ink.session.selection
                  : undefined,
              )}
          />
        )}
      </div>
      {showInspector && (
        <div className="ink-floating" style={{ right: 12, top: 56 }}>
          <div className="ink-panel-header">
            <span className="ink-panel-title">Inspector</span>
            <span className="ink-panel-actions">
              <button
                type="button"
                className="ink-button"
                data-icon-only="true"
                onClick={() =>
                  ink.session.select([])}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          </div>
          <div style={{ overflow: "auto" }}>
            <Inspector />
          </div>
        </div>
      )}
    </div>
  );
}
