import type { GameDevelopmentContext } from "../browser/game_development_context.ts";
import { EditorLink, IconButton } from "@ink/editor-ui/controls.tsx";
import {
  BugAntIcon,
  CameraIcon,
  CubeTransparentIcon,
  PencilSquareIcon,
  PlayIcon,
} from "@heroicons/react/24/outline";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  default_dungeon_debug_camera,
  dolly_dungeon_debug_camera,
  type DungeonDebugCamera,
  move_dungeon_debug_camera,
  orbit_dungeon_debug_camera,
  pan_dungeon_debug_camera,
} from "./dungeon_debug_camera.ts";
import "@ink/editor-ui/styles.css";
import "./dungeon_debug_view.css";

interface DebugCameraDrag {
  readonly mode: "orbit" | "pan";
  readonly pointer_id: number;
  readonly start: { readonly x: number; readonly y: number };
  readonly camera: DungeonDebugCamera;
}

const movement_keys = new Set([
  "w",
  "a",
  "s",
  "d",
  "q",
  "e",
  "f",
  "shift",
]);

export function render_dungeon_debug_view(context: GameDevelopmentContext) {
  return <DungeonDebugView context={context} />;
}

function DungeonDebugView(
  { context }: { readonly context: GameDevelopmentContext },
) {
  const [camera, set_camera] = useState(default_dungeon_debug_camera);
  const [drag_mode, set_drag_mode] = useState<DebugCameraDrag["mode"]>();
  const viewport_reference = useRef<HTMLElement>(null);
  const camera_reference = useRef(default_dungeon_debug_camera);
  const drag_reference = useRef<DebugCameraDrag | undefined>(undefined);
  const held_keys_reference = useRef(new Set<string>());

  useEffect(() => {
    viewport_reference.current?.focus({ preventScroll: true });
  }, []);

  const apply_camera = (next: DungeonDebugCamera) => {
    camera_reference.current = next;
    set_camera(next);
    context.set_host_camera({
      yaw_radians: next.yaw / 1_000_000,
      pitch_radians: next.pitch / 1_000_000,
      position_offset: [
        next.offset_x / 1_000_000,
        next.offset_y / 1_000_000,
        next.offset_z / 1_000_000,
      ],
      distance_scale: default_dungeon_debug_camera.zoom / next.zoom,
    });
  };

  useEffect(() => {
    const held_keys = held_keys_reference.current;
    const capture_movement_key = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!movement_keys.has(key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (key === "f") {
        if (!event.repeat) apply_camera(default_dungeon_debug_camera);
        return;
      }
      held_keys.add(key);
    };
    const release_movement_key = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!movement_keys.has(key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      held_keys.delete(key);
    };
    const release_all_movement = () => held_keys.clear();
    globalThis.addEventListener("keydown", capture_movement_key, true);
    globalThis.addEventListener("keyup", release_movement_key, true);
    globalThis.addEventListener("blur", release_all_movement);

    let previous_time = performance.now();
    let animation_frame = 0;
    const move_camera = (time: number) => {
      const elapsed_milliseconds = time - previous_time;
      previous_time = time;
      const movement = {
        forward: Number(held_keys.has("w")) - Number(held_keys.has("s")),
        right: Number(held_keys.has("d")) - Number(held_keys.has("a")),
        vertical: Number(held_keys.has("e")) - Number(held_keys.has("q")),
      };
      if (
        movement.forward !== 0 || movement.right !== 0 ||
        movement.vertical !== 0
      ) {
        apply_camera(
          move_dungeon_debug_camera(
            camera_reference.current,
            movement,
            elapsed_milliseconds,
            held_keys.has("shift") ? 3 : 1,
          ),
        );
      }
      animation_frame = requestAnimationFrame(move_camera);
    };
    animation_frame = requestAnimationFrame(move_camera);
    return () => {
      cancelAnimationFrame(animation_frame);
      held_keys.clear();
      globalThis.removeEventListener("keydown", capture_movement_key, true);
      globalThis.removeEventListener("keyup", release_movement_key, true);
      globalThis.removeEventListener("blur", release_all_movement);
    };
  }, []);

  const begin_camera_drag = (event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.focus({ preventScroll: true });
    if (event.button !== 1 && event.button !== 2) return;
    event.preventDefault();
    const drag: DebugCameraDrag = {
      mode: event.button === 2 ? "orbit" : "pan",
      pointer_id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      camera: camera_reference.current,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    drag_reference.current = drag;
    set_drag_mode(drag.mode);
  };

  const move_camera_drag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = drag_reference.current;
    if (!drag || drag.pointer_id !== event.pointerId) return;
    const movement_x = event.clientX - drag.start.x;
    const movement_y = event.clientY - drag.start.y;
    apply_camera(
      drag.mode === "orbit"
        ? orbit_dungeon_debug_camera(drag.camera, movement_x, movement_y)
        : pan_dungeon_debug_camera(drag.camera, movement_x, movement_y),
    );
  };

  const finish_camera_drag = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag_reference.current?.pointer_id !== event.pointerId) return;
    drag_reference.current = undefined;
    set_drag_mode(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <section
      className="dungeon-debug-overlay ink-editor-surface"
      data-theme="dark"
      data-density="compact"
      aria-label="Dungeon debug mode"
    >
      <section
        ref={viewport_reference}
        className="dungeon-debug-viewport"
        data-camera-drag={drag_mode}
        aria-label="Debug camera"
        tabIndex={0}
        onPointerDown={begin_camera_drag}
        onPointerMove={move_camera_drag}
        onPointerUp={finish_camera_drag}
        onPointerCancel={finish_camera_drag}
        onContextMenu={(event) => event.preventDefault()}
        onWheel={(event) => {
          event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
          apply_camera(
            dolly_dungeon_debug_camera(camera_reference.current, event.deltaY),
          );
        }}
      />

      <header className="dungeon-debug-header">
        <div className="dungeon-debug-identity">
          <span className="dungeon-debug-mode">
            <BugAntIcon /> Debug
          </span>
          <span className="dungeon-debug-separator" aria-hidden="true" />
          <CubeTransparentIcon />
          <span>
            <strong>Dungeon Workshop</strong>
            <small>inspection camera</small>
          </span>
        </div>
        <nav className="dungeon-debug-navigation" aria-label="Runtime modes">
          <EditorLink href="/editor" target="ink-dungeon-editor">
            <PencilSquareIcon /> Edit
          </EditorLink>
          <EditorLink href="/debug" current>
            <BugAntIcon /> Debug
          </EditorLink>
          <EditorLink href="/game" target="ink-game-preview">
            <PlayIcon /> Play
          </EditorLink>
        </nav>
      </header>

      <div className="dungeon-debug-camera-readout">
        <span>Camera</span>
        <output aria-label="Debug camera position">
          X {(camera.offset_x / 1_000_000).toFixed(1)} · Y{" "}
          {(camera.offset_y / 1_000_000).toFixed(1)} · Z{" "}
          {(camera.offset_z / 1_000_000).toFixed(1)}
        </output>
        <output aria-label="Debug camera zoom">
          {Math.round(camera.zoom / default_dungeon_debug_camera.zoom * 100)}%
        </output>
        <IconButton
          label="Reset debug camera"
          icon={<CameraIcon />}
          tone="ghost"
          onPress={() => apply_camera(default_dungeon_debug_camera)}
        />
      </div>

      <aside className="dungeon-debug-help" aria-label="Debug camera controls">
        <span>
          <kbd>RMB</kbd> Orbit
        </span>
        <span>
          <kbd>MMB</kbd> Pan
        </span>
        <span>
          <kbd>Wheel</kbd> Dolly
        </span>
        <span>
          <kbd>WASD</kbd> Fly
        </span>
        <span>
          <kbd>Q E</kbd> Down / up
        </span>
        <span>
          <kbd>Shift</kbd> Boost
        </span>
        <span>
          <kbd>F</kbd> Reset
        </span>
      </aside>
    </section>
  );
}
