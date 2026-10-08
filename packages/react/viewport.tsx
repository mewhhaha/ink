/**
 * A view into the world. Editor views (perspective, top, front, side) have
 * camera controls, picking, transform gizmos and pluggable tools; the game
 * view looks through the game's active camera and, while playing, sends
 * keyboard and pointer input to the game.
 */
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  mat4,
  type Quat,
  quat,
  type Ray,
  rayFromNdc,
  type Vec3,
  vec3,
} from "@ink/geometry";
import {
  type Camera,
  type Environment,
  gameCamera,
  type Line,
  type Pick,
  type Quality,
  type RenderScene,
  sceneGizmos,
  type View,
} from "@ink/render";
import { type CameraPose, type Session, SharedSession } from "@ink/core";
import { sharedSelectionLines } from "./shared.tsx";
import { useInk, useSessionValue, useUi } from "./context.tsx";
import {
  cameraPose,
  defaultCamera,
  type EditorCamera,
  fly,
  frame,
  look,
  orbit,
  pan,
  pixelSize,
  renderCamera,
  type ViewKind,
  viewPlane,
  zoom,
} from "./cameras.ts";
import {
  type Axis,
  dragRotate,
  dragScale,
  dragTranslate,
  gizmoLines,
  gizmoScale,
  hitGizmo,
  rayPlane,
} from "./gizmo.ts";
import { Icon } from "./icons.tsx";
import { useDropdown } from "./menu.tsx";
import type { UiState } from "./store.ts";
import {
  CommentComposer,
  CommentPins,
  type ComposerState,
} from "./comments.tsx";
import { BuildErrors } from "./console.tsx";
import { ASSET_MIME } from "./assets.tsx";
import { matchShortcut } from "./commands.ts";
import { marqueeEntities, selectionDescendants } from "./selection.ts";
import { snapGeometry } from "./snapping.ts";
import { stationaryBrushTextures } from "./texture_lock.ts";

export type ViewName = ViewKind | "game";

/** What a viewport tool can see and do. */
export interface ViewportContext {
  session: Session;
  view: View;
  kind: ViewName;
  camera: Camera;
  scene: RenderScene;
  width: number;
  height: number;
  ui: UiState;
  /** World ray through a CSS-pixel position. */
  ray(x: number, y: number): Ray;
  /** CSS-pixel position of a world point, or null if behind the camera. */
  project(point: Vec3): [number, number] | null;
  pick(x: number, y: number): Promise<Pick | null>;
  /** The point on the view's construction plane (the ground for perspective
   * views, the axis plane through `through` for orthographic ones). */
  planePoint(x: number, y: number, through?: Vec3): Vec3 | null;
  /** Snap to the configured grid/surface/vertex target (Ctrl inverts). */
  snap(point: Vec3, invert?: boolean): Vec3;
  /** World units per CSS pixel at a point. */
  pixel(point?: Vec3): number;
  redraw(): void;
}

export interface PointerInfo {
  x: number;
  y: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  event: PointerEvent | React.PointerEvent;
}

/** A tool active in editor views when `ui.tool` equals its id. */
export interface ViewportTool {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  cursor?:
    | string
    | ((
      ctx: ViewportContext,
      pointer: PointerInfo | null,
      dragging: boolean,
    ) => string);
  /** Return true to take the drag; the tool then gets move/up events. */
  pointerDown?(
    ctx: ViewportContext,
    e: PointerInfo,
  ): boolean | void | Promise<boolean | void>;
  pointerMove?(ctx: ViewportContext, e: PointerInfo, dragging: boolean): void;
  pointerUp?(ctx: ViewportContext, e: PointerInfo): void;
  keyDown?(ctx: ViewportContext, e: KeyboardEvent): boolean | void;
  /** Lines drawn on top every frame. */
  overlay?(ctx: ViewportContext): Line[];
  /** Hide the transform gizmo while active. */
  noGizmo?: boolean;
}

export interface ViewportProps {
  /** Persists the editor camera under this id. */
  id: string;
  view?: ViewName;
  label?: string;
  grid?: boolean;
  shading?: "lit" | "unlit" | "wireframe";
  edges?: boolean;
  gizmos?: boolean;
  /** Route keys and pointer to the game while playing (game view: true). */
  gameInput?: boolean;
  pointerLock?: boolean;
  /** Show build errors over this view. */
  diagnostics?: boolean;
  /** Let the label switch between view kinds. */
  switcher?: boolean;
  tools?: ViewportTool[];
  /** Brush faces to highlight (`{ entity, face }`), re-drawn when it notifies. */
  selectedFaces?: {
    get(): readonly { entity: number; face: number }[];
    subscribe(listener: () => void): () => void;
  };
  /** Extra lines each frame, e.g. game debug drawing. */
  overlay?: (ctx: ViewportContext) => Line[];
  /** Sky-side ambient light (sRGB 0..1); dim it for indoor levels. */
  ambient?: [number, number, number, number];
  /** A flat clear colour instead of the sky gradient. */
  background?: [number, number, number, number];
  /** Overrides of the scene's `environment` for this view (exposure,
   * tonemap, bloom, fog...). */
  environment?: Partial<Environment>;
  /** `low` skips bloom and auto exposure. Default: the renderer's. */
  quality?: Quality;
  /** Buttons shown in the view's top-right corner. */
  actions?: ReactNode;
  /** Content over the view: a HUD, labels. */
  children?: ReactNode;
  style?: CSSProperties;
}

interface Drag {
  kind: "look" | "orbit" | "pan" | "gizmo" | "tool" | "click";
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  gizmo?: GizmoDrag;
}

interface GizmoDrag {
  axis: Axis;
  origin: Vec3;
  eye: Vec3;
  scale: number;
  ray: Ray;
  targets: {
    id: number;
    world: Vec3;
    worldRotation: Quat;
    parent: Float32Array;
    parentRotation: Quat;
    scale: Vec3;
  }[];
  commit(): void;
  cancel(): void;
  update(recipe: Parameters<Session["edit"]>[1]): void;
}

const GAME_KEYS_PASS = new Set([
  "F5",
  "F6",
  "F7",
  "F8",
  "F11",
  "F12",
  "Escape",
]);

function loadCamera(id: string, kind: ViewKind): EditorCamera {
  try {
    const stored = JSON.parse(
      localStorage.getItem(`ink:camera:${location.pathname}:${id}`) ?? "null",
    );
    if (stored && stored.kind === kind) {
      return { ...defaultCamera(kind), ...stored };
    }
  } catch {
    // no stored camera
  }
  return defaultCamera(kind);
}

export function Viewport(props: ViewportProps) {
  const ink = useInk();
  const { session, renderer, loop } = ink;
  const [kind, setKind] = useState<ViewName>(props.view ?? "perspective");
  useEffect(() => setKind(props.view ?? "perspective"), [props.view]);
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View | null>(null);
  const editorKind: ViewKind = kind === "game" ? "perspective" : kind;
  const cameraRef = useRef<EditorCamera>(loadCamera(props.id, editorKind));
  const lastCamera = useRef<Camera | null>(null);
  const size = useRef({ width: 1, height: 1 });
  const drag = useRef<Drag | null>(null);
  const keys = useRef(new Set<string>());
  const hoverAxis = useRef<Axis | null>(null);
  const dirty = useRef(true);
  const signature = useRef("");
  const pinsUpdate = useRef<(() => void) | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [toolCursor, setToolCursor] = useState<string>();
  const [marquee, setMarquee] = useState<
    { start: [number, number]; end: [number, number] } | null
  >(null);
  const pointer = useRef<PointerInfo | null>(null);
  const ui = useUi((u) => u);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const mode = useSessionValue((s) => s.mode);
  const hasCamera = useSessionValue((s) =>
    s.world.entities.some((e) =>
      (e.components.camera as { active?: boolean } | undefined)?.active
    )
  );
  const toolsRef = useRef(props.tools);
  toolsRef.current = props.tools;
  const propsRef = useRef(props);
  propsRef.current = props;
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const paused = useSessionValue((s) => s.paused);
  // Input goes to the game while it runs; pausing or comment mode hands the
  // view back to editing, so you can click things in the game and change them.
  const playingGame = kind === "game" && mode === "play" && !paused &&
    !ui.commenting && (props.gameInput ?? true);
  const playingRef = useRef(playingGame);
  playingRef.current = playingGame;

  useEffect(() => {
    if (kind !== "game") cameraRef.current = loadCamera(props.id, kind);
    dirty.current = true;
  }, [kind, props.id]);

  const saveCamera = () => {
    try {
      localStorage.setItem(
        `ink:camera:${location.pathname}:${props.id}`,
        JSON.stringify(cameraRef.current),
      );
    } catch {
      // storage unavailable
    }
  };

  const activeTool = (): ViewportTool | undefined =>
    kindRef.current === "game"
      ? undefined
      : toolsRef.current?.find((t) => t.id === uiRef.current.tool);

  // Camera for this frame.
  const currentCamera = (scene: RenderScene): Camera => {
    const aspect = size.current.width / size.current.height;
    if (kindRef.current === "game") {
      return gameCamera(scene, aspect) ??
        renderCamera(cameraRef.current, aspect);
    }
    return renderCamera(cameraRef.current, aspect);
  };

  const context = (): ViewportContext | null => {
    const view = viewRef.current;
    const camera = lastCamera.current;
    if (!view || !camera) return null;
    const scene = ink.scene();
    const { width, height } = size.current;
    const inverse = mat4.invert(mat4.multiply(camera.projection, camera.view));
    const viewProjection = mat4.multiply(camera.projection, camera.view);
    const ray = (x: number, y: number) =>
      rayFromNdc(inverse, [(x / width) * 2 - 1, 1 - (y / height) * 2]);
    const k = kindRef.current;
    return {
      session,
      view,
      kind: k,
      camera,
      scene,
      width,
      height,
      ui: uiRef.current,
      ray,
      project(point) {
        const p = viewProjection;
        const x = p[0] * point[0] + p[4] * point[1] + p[8] * point[2] + p[12];
        const y = p[1] * point[0] + p[5] * point[1] + p[9] * point[2] + p[13];
        const w = p[3] * point[0] + p[7] * point[1] + p[11] * point[2] + p[15];
        if (w <= 1e-6) return null;
        return [((x / w + 1) / 2) * width, ((1 - y / w) / 2) * height];
      },
      pick: (x, y) => view.pick(x, y),
      planePoint(x, y, through = [0, 0, 0]) {
        const r = ray(x, y);
        const normal = k === "game"
          ? [0, 1, 0] as Vec3
          : viewPlane(k === "perspective" ? "perspective" : k).normal;
        return rayPlane(r, normal, through) ??
          rayPlane(r, vec3.scale(normal, -1), through);
      },
      snap(point, invert) {
        const on = uiRef.current.snap !== Boolean(invert);
        const grid = uiRef.current.grid;
        const mode = uiRef.current.snapTarget;
        if (on && mode !== "grid") {
          const screen = this.project(point);
          if (screen) {
            return snapGeometry({
              scene,
              assets: renderer?.assets,
              exclude: selectionDescendants(
                session.world.entities,
                session.selection,
              ),
              mode,
              ray: ray(...screen),
              project: this.project,
              screen,
            }) ?? point;
          }
          return point;
        }
        return on
          ? point.map((v) => Math.round(v / grid) * grid) as Vec3
          : point;
      },
      pixel(point) {
        if (camera.orthographic) return cameraRef.current.size / height;
        const distance = point
          ? vec3.distance(point, camera.position)
          : cameraRef.current.distance;
        const fov = k === "game" ? 60 : cameraRef.current.fov;
        return (2 * distance * Math.tan((fov * Math.PI) / 360)) / height;
      },
      redraw: () => (dirty.current = true),
    };
  };

  // Selection origin and gizmo size.
  const gizmoState = (ctx: ViewportContext) => {
    if (propsRef.current.gizmos === false || ctx.kind === "game") return null;
    const tool = uiRef.current.tool;
    if (tool !== "move" && tool !== "rotate" && tool !== "scale") return null;
    if (activeTool()?.noGizmo) return null;
    const world = session.world;
    const targets = session.selection.filter((id) =>
      world.entities.find((e) => e.id === id)?.components.transform
    );
    if (targets.length === 0) return null;
    let origin: Vec3 = [0, 0, 0];
    for (const id of targets) {
      const m = ctx.scene.matrices.get(id);
      if (m) origin = vec3.add(origin, [m[12], m[13], m[14]]);
    }
    origin = vec3.scale(origin, 1 / targets.length);
    const perPixel = ctx.camera.orthographic
      ? cameraRef.current.size / ctx.height
      : (2 * Math.tan((cameraRef.current.fov * Math.PI) / 360)) / ctx.height;
    const scale = gizmoScale(
      origin,
      ctx.camera.position,
      perPixel,
      ctx.camera.orthographic,
    );
    return { tool, origin, scale, targets };
  };

  // Create the GPU view once the renderer exists.
  useEffect(() => {
    if (!renderer || !canvas.current) return;
    const view = renderer.createView(canvas.current);
    viewRef.current = view;
    const element = container.current!;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      size.current = {
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      };
      view.resize(size.current.width, size.current.height, devicePixelRatio);
      dirty.current = true;
    });
    observer.observe(element);
    const offAssets = renderer.assets.onChange(() => (dirty.current = true));
    const handle = {
      id: props.id,
      label: props.label ?? kindRef.current,
      capture: async () => blobToDataUrl(await view.capture()),
      pose: (): CameraPose | null => {
        if (kindRef.current !== "game") return cameraPose(cameraRef.current);
        const c = ink.scene().cameras.find((x) => x.camera.active);
        if (!c) return cameraPose(cameraRef.current);
        const { t, r } = mat4.decompose(c.matrix);
        return {
          position: t,
          rotation: r,
          fov: c.camera.fov,
          orthographic: c.camera.orthographic,
          size: c.camera.size,
          view: "game",
        };
      },
      project: (point: [number, number, number]) =>
        context()?.project(point) ?? null,
    };
    ink.views.set(props.id, handle);
    return () => {
      ink.views.delete(props.id);
      offAssets();
      observer.disconnect();
      view.dispose();
      viewRef.current = null;
    };
  }, [renderer]);

  // Draw when something changed.
  useEffect(() => {
    return loop.add((dt) => {
      const view = viewRef.current;
      if (!view) return;
      const held = keys.current;
      if (
        drag.current?.kind === "look" && held.size > 0 &&
        cameraRef.current.kind === "perspective"
      ) {
        const before = cameraRef.current;
        cameraRef.current = fly(
          before,
          held,
          dt,
          Math.max(2, before.distance * 1.2),
        );
        if (cameraRef.current !== before) dirty.current = true;
      }
      const scene = ink.scene();
      const camera = currentCamera(scene);
      const u = uiRef.current;
      const sharedVersion = session.documentDriver instanceof SharedSession
        ? session.documentDriver.version
        : 0;
      const sig =
        `${session.version}|${sharedVersion}|${session.hovered}|${kindRef.current}|${u.tool}|${u.grid}|${u.snap}|${hoverAxis.current}`;
      if (
        !dirty.current && sig === signature.current &&
        kindRef.current !== "game"
      ) return;
      if (
        !dirty.current && sig === signature.current &&
        kindRef.current === "game" && session.mode !== "play"
      ) return;
      signature.current = sig;
      dirty.current = false;
      lastCamera.current = camera;
      const ctx = context();
      const tool = activeTool();
      if (ctx && typeof tool?.cursor === "function") {
        setToolCursor(
          tool.cursor(ctx, pointer.current, drag.current?.kind === "tool"),
        );
      }
      const lines: Line[] = [];
      if (ctx) {
        const gizmo = gizmoState(ctx);
        if (gizmo) {
          lines.push(
            ...gizmoLines(
              gizmo.tool,
              gizmo.origin,
              gizmo.scale,
              drag.current?.gizmo?.axis ?? hoverAxis.current,
              camera.position,
            ),
          );
        }
        // Debug lines the game emitted on its latest step.
        for (const event of session.frameEvents) {
          if (event.name !== "line") continue;
          const v = event.value as {
            start: Vec3;
            end: Vec3;
            color: [number, number, number, number];
          };
          lines.push({ from: v.start, to: v.end, color: v.color, width: 2 });
        }
        // Lights and cameras have no geometry; draw them in editor views.
        if (kindRef.current !== "game" && propsRef.current.gizmos !== false) {
          lines.push(...sceneGizmos(scene, { selection: session.selection }));
          lines.push(...sharedSelectionLines(session, scene));
        }
        const tool = activeTool();
        if (tool?.overlay) lines.push(...tool.overlay(ctx));
        if (propsRef.current.overlay) {
          lines.push(...propsRef.current.overlay(ctx));
        }
      }
      const k = kindRef.current;
      const showEditing =
        !(k === "game" && session.mode === "play" && !session.paused);
      view.render(scene, camera, {
        grid: propsRef.current.grid ?? k !== "game"
          ? {
            plane: k === "front" ? "xy" : k === "side" ? "yz" : "xz",
            spacing: u.grid,
            major: 10,
          }
          : false,
        selection: showEditing ? session.selection : [],
        selectedFaces: showEditing
          ? propsRef.current.selectedFaces?.get()
          : undefined,
        hovered: showEditing ? session.hovered : 0,
        shading: propsRef.current.shading ??
          (k === "top" || k === "front" || k === "side" ? "unlit" : "lit"),
        edges: propsRef.current.edges ?? k !== "game",
        ambient: propsRef.current.ambient,
        background: propsRef.current.background,
        environment: propsRef.current.environment,
        quality: propsRef.current.quality,
        lines,
      });
      pinsUpdate.current?.();
    });
  }, [loop, session]);

  useEffect(
    () => props.selectedFaces?.subscribe(() => (dirty.current = true)),
    [props.selectedFaces],
  );

  // Hover picking, throttled.
  const pendingHover = useRef<{ x: number; y: number } | null>(null);
  const hoverBusy = useRef(false);
  const runHover = async () => {
    if (hoverBusy.current || !pendingHover.current) return;
    const view = viewRef.current;
    if (!view) return;
    hoverBusy.current = true;
    const { x, y } = pendingHover.current;
    pendingHover.current = null;
    try {
      const hit = await view.pick(x, y);
      if (playingRef.current) {
        session.input.pointer({
          hovered: hit?.entity ?? 0,
          point: hit?.point ?? [0, 0, 0],
        });
      } else if (!drag.current) session.hover(hit?.entity ?? 0);
    } finally {
      hoverBusy.current = false;
      if (pendingHover.current) setTimeout(runHover, 30);
    }
  };

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = container.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const info = (event: React.PointerEvent): PointerInfo => {
    const { x, y } = local(event);
    return {
      x,
      y,
      button: event.button,
      shift: event.shiftKey,
      ctrl: event.ctrlKey || event.metaKey,
      alt: event.altKey,
      event,
    };
  };

  const beginGizmo = (
    ctx: ViewportContext,
    axis: Axis,
    ray: Ray,
    origin: Vec3,
    scale: number,
    ids: number[],
  ): GizmoDrag => {
    const world = session.world;
    const roots = ids.filter((id) => {
      let parent = world.entities.find((e) => e.id === id)?.parent ?? 0;
      const visited = new Set<number>();
      while (parent && !visited.has(parent)) {
        if (ids.includes(parent)) return false;
        visited.add(parent);
        parent = world.entities.find((e) => e.id === parent)?.parent ?? 0;
      }
      return true;
    });
    const targets = roots.map((id) => {
      const entity = world.entities.find((e) => e.id === id)!;
      const m = ctx.scene.matrices.get(id) ?? mat4.identity();
      const parent = ctx.scene.matrices.get(entity.parent) ?? mat4.identity();
      const t = entity.components.transform as { scale: Vec3 };
      return {
        id,
        world: [m[12], m[13], m[14]] as Vec3,
        worldRotation: mat4.decompose(m).r,
        parent,
        parentRotation: mat4.decompose(parent).r,
        scale: [...t.scale] as Vec3,
      };
    });
    const label = uiRef.current.tool === "move"
      ? "Move"
      : uiRef.current.tool === "rotate"
      ? "Rotate"
      : "Scale";
    const transaction = session.begin(
      ids.length === 1
        ? `${label} ${session.nameOf(ids[0])}`
        : `${label} ${ids.length}`,
    );
    return {
      axis,
      origin,
      eye: ctx.camera.position,
      scale,
      ray,
      targets,
      commit: transaction.commit,
      cancel: transaction.cancel,
      update: (() => {
        const preserve = stationaryBrushTextures(world);
        return (recipe) =>
          transaction.update((world, names) => {
            recipe(world, names);
            if (!uiRef.current.textureLock) preserve(world);
          });
      })(),
    };
  };

  const applyGizmo = (g: GizmoDrag, ray: Ray, ctrl: boolean) => {
    const u = uiRef.current;
    const snapping = u.snap !== ctrl;
    const tool = u.tool;
    if (tool === "move") {
      let delta = dragTranslate(g.axis, g.origin, g.eye, g.ray, ray);
      if (snapping) {
        // Snap the selection origin, not the offset, so things land on the grid.
        const wanted = vec3.add(g.origin, delta);
        const target = context()?.snap(wanted, ctrl) ?? wanted;
        const raw = vec3.sub(target, g.origin);
        delta = [0, 1, 2].map((
          i,
        ) => (Math.abs(delta[i]) < 1e-9 ? 0 : raw[i])) as Vec3;
      }
      g.update((world) => {
        for (const t of g.targets) {
          const e = world.entities.find((x) => x.id === t.id);
          const transform = e?.components.transform as
            | { position: Vec3 }
            | undefined;
          if (!transform) continue;
          transform.position = mat4.transformPoint(
            mat4.invert(t.parent),
            vec3.add(t.world, delta),
          );
        }
      });
    } else if (tool === "rotate") {
      const r = dragRotate(g.axis, g.origin, g.eye, g.ray, ray);
      let angle = r.angle;
      if (snapping) {
        const step = (u.angleSnap * Math.PI) / 180;
        angle = Math.round(angle / step) * step;
      }
      const q = quat.fromAxisAngle(r.axis, angle);
      g.update((world) => {
        for (const t of g.targets) {
          const e = world.entities.find((x) => x.id === t.id);
          const transform = e?.components.transform as {
            position: Vec3;
            rotation: Quat;
          } | undefined;
          if (!transform) continue;
          const worldRotation = quat.multiply(q, t.worldRotation);
          transform.rotation = quat.normalize(
            quat.multiply(quat.conjugate(t.parentRotation), worldRotation),
          );
          const position = vec3.add(
            g.origin,
            quat.rotate(q, vec3.sub(t.world, g.origin)),
          );
          transform.position = mat4.transformPoint(
            mat4.invert(t.parent),
            position,
          );
        }
      });
    } else if (tool === "scale") {
      let factor = dragScale(g.axis, g.origin, g.eye, g.scale, g.ray, ray);
      if (snapping) {
        factor = factor.map((f) =>
          Math.max(0.1, Math.round(f * 10) / 10)
        ) as Vec3;
      }
      g.update((world) => {
        for (const t of g.targets) {
          const e = world.entities.find((x) => x.id === t.id);
          const transform = e?.components.transform as
            | { scale: Vec3 }
            | undefined;
          if (transform) {
            transform.scale = [
              t.scale[0] * factor[0],
              t.scale[1] * factor[1],
              t.scale[2] * factor[2],
            ];
          }
        }
      });
    }
  };

  const onPointerDown = async (event: React.PointerEvent) => {
    container.current?.focus();
    const p = info(event);
    if (playingRef.current) {
      session.input.keyDown(
        ["MouseLeft", "MouseMiddle", "MouseRight"][event.button] ??
          `Mouse${event.button}`,
      );
      if (
        props.pointerLock && document.pointerLockElement !== container.current
      ) container.current?.requestPointerLock?.();
      return;
    }
    const ctx = context();
    if (!ctx) return;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    const ortho = ctx.kind !== "perspective" && ctx.kind !== "game";
    const base = { x: p.x, y: p.y, lastX: p.x, lastY: p.y, moved: false };
    if (event.button === 2) {
      drag.current = {
        ...base,
        kind: ortho || ctx.kind === "game" ? "pan" : "look",
      };
      return;
    }
    if (event.button === 1) {
      drag.current = {
        ...base,
        kind: ortho || event.shiftKey ? "pan" : "orbit",
      };
      return;
    }
    if (event.button !== 0) return;
    if (ctx.kind === "game") {
      drag.current = { ...base, kind: "click" };
      return;
    }
    if (event.altKey && !ortho) {
      drag.current = { ...base, kind: "orbit" };
      return;
    }
    if (uiRef.current.commenting) {
      drag.current = { ...base, kind: "click" };
      return;
    }
    const tool = activeTool();
    if (tool?.pointerDown && (await tool.pointerDown(ctx, p))) {
      drag.current = { ...base, kind: "tool" };
      return;
    }
    const gizmo = gizmoState(ctx);
    if (gizmo) {
      const ray = ctx.ray(p.x, p.y);
      const axis = hitGizmo(
        gizmo.tool,
        gizmo.origin,
        gizmo.scale,
        ray,
        ctx.camera.position,
      );
      if (axis) {
        drag.current = {
          ...base,
          kind: "gizmo",
          gizmo: beginGizmo(
            ctx,
            axis,
            ray,
            gizmo.origin,
            gizmo.scale,
            gizmo.targets,
          ),
        };
        return;
      }
    }
    drag.current = { ...base, kind: "click" };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const p = info(event);
    pointer.current = p;
    const ctx = context();
    const tool = activeTool();
    if (ctx && typeof tool?.cursor === "function") {
      setToolCursor(tool.cursor(ctx, p, drag.current?.kind === "tool"));
    }
    if (playingRef.current) {
      const { width, height } = size.current;
      const ray = ctx ? ctx.ray(p.x, p.y) : undefined;
      session.input.pointer({
        position: [(p.x / width) * 2 - 1, 1 - (p.y / height) * 2],
        inside: true,
        locked: document.pointerLockElement === container.current,
        ...(ray ? { ray } : {}),
      });
      session.input.pointerMove(event.movementX, event.movementY);
      pendingHover.current = p;
      runHover();
      return;
    }
    const d = drag.current;
    if (!d) {
      if (!ctx) return;
      const gizmo = gizmoState(ctx);
      const axis = gizmo
        ? hitGizmo(
          gizmo.tool,
          gizmo.origin,
          gizmo.scale,
          ctx.ray(p.x, p.y),
          ctx.camera.position,
        )
        : null;
      if (axis !== hoverAxis.current) {
        hoverAxis.current = axis;
        dirty.current = true;
      }
      activeTool()?.pointerMove?.(ctx, p, false);
      if (!axis) {
        pendingHover.current = p;
        runHover();
      }
      return;
    }
    const dx = p.x - d.lastX, dy = p.y - d.lastY;
    d.lastX = p.x;
    d.lastY = p.y;
    if (Math.abs(p.x - d.x) + Math.abs(p.y - d.y) > 3) d.moved = true;
    const cam = cameraRef.current;
    switch (d.kind) {
      case "click":
        if (d.moved && ctx?.kind !== "game" && !uiRef.current.commenting) {
          setMarquee({ start: [d.x, d.y], end: [p.x, p.y] });
        }
        return;
      case "look":
        cameraRef.current = look(cam, dx, dy);
        break;
      case "orbit":
        cameraRef.current = orbit(cam, dx, dy);
        break;
      case "pan":
        if (kindRef.current === "game") return;
        cameraRef.current = pan(
          cam,
          dx,
          dy,
          pixelSize(cam, size.current.height),
        );
        break;
      case "gizmo":
        if (ctx && d.gizmo) applyGizmo(d.gizmo, ctx.ray(p.x, p.y), p.ctrl);
        return;
      case "tool":
        if (ctx) activeTool()?.pointerMove?.(ctx, p, true);
        dirty.current = true;
        return;
      default:
        return;
    }
    dirty.current = true;
  };

  const onPointerUp = async (event: React.PointerEvent) => {
    const p = info(event);
    if (playingRef.current) {
      session.input.keyUp(
        ["MouseLeft", "MouseMiddle", "MouseRight"][event.button] ??
          `Mouse${event.button}`,
      );
      return;
    }
    const d = drag.current;
    drag.current = null;
    setMarquee(null);
    if (!d) return;
    const ctx = context();
    if (
      d.kind === "click" && d.moved && ctx && ctx.kind !== "game" &&
      !uiRef.current.commenting
    ) {
      session.select(
        marqueeEntities(ctx.scene, ctx.project, [d.x, d.y], [p.x, p.y]),
        p.shift ? "add" : p.ctrl ? "toggle" : "replace",
      );
      return;
    }
    if (d.kind === "look" || d.kind === "orbit" || d.kind === "pan") {
      keys.current.clear();
      saveCamera();
      return;
    }
    if (d.kind === "gizmo") {
      d.gizmo?.commit();
      return;
    }
    if (d.kind === "tool") {
      if (ctx) activeTool()?.pointerUp?.(ctx, p);
      dirty.current = true;
      return;
    }
    if (d.kind === "click" && !d.moved && ctx) {
      const hit = (ctx.kind !== "game" ? pickIcon(ctx, p.x, p.y) : null) ??
        await ctx.pick(p.x, p.y);
      if (uiRef.current.commenting) {
        const point = hit?.point ?? ctx.planePoint(p.x, p.y) ?? undefined;
        const pose = ink.views.get(props.id)?.pose() ?? undefined;
        setComposer({
          x: p.x,
          y: p.y,
          anchor: {
            entity: hit?.entity || undefined,
            entityName: hit?.entity ? session.nameOf(hit.entity) : undefined,
            point,
            view: pose,
            mode: session.mode,
            tick: session.tick,
            scene: session.sceneName,
          },
        });
        return;
      }
      const id = hit?.entity ?? 0;
      if (id) {
        session.select([id], p.shift ? "add" : p.ctrl ? "toggle" : "replace");
      } else if (!p.shift && !p.ctrl) session.select([]);
    }
  };

  const cancelDrag = () => {
    drag.current?.gizmo?.cancel();
    if (drag.current?.kind === "tool") {
      const ctx = context();
      if (ctx) {
        activeTool()?.keyDown?.(
          ctx,
          new KeyboardEvent("keydown", { key: "Escape" }),
        );
      }
    }
    drag.current = null;
    setMarquee(null);
    dirty.current = true;
  };

  const onWheel = (event: React.WheelEvent) => {
    if (playingRef.current) {
      session.input.wheel(event.deltaY);
      return;
    }
    if (kindRef.current === "game") return;
    const ctx = context();
    const p = local(event);
    let target: Vec3 | undefined;
    if (ctx) {
      const ray = ctx.ray(p.x, p.y);
      target = kindRef.current === "perspective"
        ? vec3.add(
          ray.origin,
          vec3.scale(ray.direction, Math.max(1, cameraRef.current.distance)),
        )
        : ctx.planePoint(p.x, p.y, cameraRef.current.position) ?? undefined;
    }
    cameraRef.current = zoom(cameraRef.current, event.deltaY, target);
    dirty.current = true;
    saveCamera();
  };

  const frameSelection = () => {
    const scene = ink.scene();
    const ids = session.selection;
    let bounds = scene.bounds;
    if (ids.length) {
      const points = ids.map((id) => scene.matrices.get(id)).filter(Boolean)
        .map((m) => [m![12], m![13], m![14]] as Vec3);
      if (points.length) {
        const min = points.reduce((a, b) => vec3.min(a, b));
        const max = points.reduce((a, b) => vec3.max(a, b));
        bounds = {
          min: vec3.sub(min, [1, 1, 1]),
          max: vec3.add(max, [1, 1, 1]),
        };
      }
    }
    if (!bounds) return;
    cameraRef.current = frame(
      cameraRef.current,
      bounds,
      size.current.width / size.current.height,
    );
    dirty.current = true;
    saveCamera();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (playingRef.current) {
      if (
        GAME_KEYS_PASS.has(event.code) || event.ctrlKey || event.metaKey ||
        Object.values(uiRef.current.shortcuts).flat().some((key) =>
          matchShortcut(event.nativeEvent, key)
        )
      ) {
        return;
      }
      session.input.keyDown(event.code);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (drag.current?.kind === "look") {
      keys.current.add(event.code);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape" && drag.current?.kind === "gizmo") {
      drag.current.gizmo?.cancel();
      drag.current = null;
      event.stopPropagation();
      return;
    }
    const ctx = context();
    const tool = activeTool();
    if (ctx && tool?.keyDown?.(ctx, event.nativeEvent)) {
      event.preventDefault();
      event.stopPropagation();
      dirty.current = true;
      return;
    }
    if (event.code === "KeyF" && !event.ctrlKey && !event.metaKey) {
      frameSelection();
      event.stopPropagation();
    }
  };
  const onKeyUp = (event: React.KeyboardEvent) => {
    keys.current.delete(event.code);
    if (playingRef.current) session.input.keyUp(event.code);
  };

  useEffect(() => {
    const blur = () => {
      keys.current.clear();
      session.input.releaseAll();
    };
    addEventListener("blur", blur);
    return () => removeEventListener("blur", blur);
  }, [session]);

  const dropdown = useDropdown();
  const label = props.label ??
    (kind === "game" ? "Game" : kind[0].toUpperCase() + kind.slice(1));
  const tool = activeTool();
  const cursor = ui.commenting
    ? "crosshair"
    : (typeof tool?.cursor === "function" ? toolCursor : tool?.cursor) ??
      (playingGame && props.pointerLock ? "none" : undefined);

  return (
    <div
      ref={container}
      className="ink-viewport"
      data-view-id={props.id}
      tabIndex={0}
      data-playing={mode === "play" && kind === "game"}
      data-commenting={ui.commenting && !playingGame}
      style={{ cursor, ...props.style }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelDrag}
      onPointerLeave={() => {
        pointer.current = null;
        if (!drag.current) setToolCursor(undefined);
        if (playingRef.current) session.input.pointer({ inside: false });
        else if (!drag.current) session.hover(0);
      }}
      onWheel={onWheel}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ASSET_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(ASSET_MIME);
        const ctx = context();
        if (!raw || !ctx) return;
        e.preventDefault();
        const asset = JSON.parse(raw) as {
          kind: string;
          path: string;
          id: number;
        };
        if (asset.kind !== "mesh") return;
        const p = local(e);
        const at = ctx.snap(ctx.planePoint(p.x, p.y) ?? [0, 0, 0]);
        session.createEntity({
          name: asset.path.replace(/^builtin:/, "").replace(/\.[^.]+$/, "")
            .split("/").pop(),
          components: {
            transform: {
              position: at,
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            mesh: {
              shape: asset.id,
              color: [1, 1, 1, 1],
              texture: 0,
              roughness: 0.6,
              metallic: 0,
              emissive: [0, 0, 0, 1],
              cast_shadows: true,
            },
          },
        });
      }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvas} />
      {marquee && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            pointerEvents: "none",
            zIndex: 3,
            left: Math.min(marquee.start[0], marquee.end[0]),
            top: Math.min(marquee.start[1], marquee.end[1]),
            width: Math.abs(marquee.end[0] - marquee.start[0]),
            height: Math.abs(marquee.end[1] - marquee.start[1]),
            border: `1px ${
              marquee.end[0] < marquee.start[0] ? "dashed" : "solid"
            } var(--ink-accent)`,
            background: "rgba(100, 160, 255, 0.15)",
          }}
        />
      )}
      {!renderer && (
        <div className="ink-viewport-message">
          Starting WebGPU…
        </div>
      )}
      {kind === "game" && !hasCamera && (
        <div
          className="ink-viewport-message"
          style={{
            pointerEvents: "none",
            alignItems: "flex-end",
            paddingBottom: 16,
          }}
        >
          No active camera entity — showing an editor camera.
        </div>
      )}
      <div className="ink-viewport-label">
        {props.switcher !== false
          ? (
            <button
              type="button"
              className="ink-button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) =>
                dropdown(
                  e.currentTarget,
                  ([
                    "perspective",
                    "top",
                    "front",
                    "side",
                    "game",
                  ] as ViewName[]).map((k) => ({
                    label: k === "game"
                      ? "Game camera"
                      : k[0].toUpperCase() + k.slice(1),
                    icon: k === "game"
                      ? "camera"
                      : k === "perspective"
                      ? "cube"
                      : "grid",
                    run: () => setKind(k),
                  })),
                )}
            >
              {label} <Icon name="chevronDown" size={11} />
            </button>
          )
          : <span>{label}</span>}
      </div>
      {props.actions && (
        <div
          className="ink-viewport-tools"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {props.actions}
        </div>
      )}
      <div
        className="ink-overlay-layer"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <CommentPins
          viewId={props.id}
          register={(update) => (pinsUpdate.current = update)}
        />
        {composer && (
          <CommentComposer
            state={composer}
            viewId={props.id}
            onClose={() => setComposer(null)}
          />
        )}
      </div>
      {props.children && <div className="ink-hud">{props.children}</div>}
      {props.diagnostics && <BuildErrors />}
    </div>
  );
}

/** Entities without geometry (lights, cameras, empties) are picked by how
 * close their origin is on screen. */
function pickIcon(ctx: ViewportContext, x: number, y: number): Pick | null {
  let best: Pick | null = null;
  let bestDistance = 12;
  for (const entity of ctx.session.world.entities) {
    const c = entity.components;
    if (c.mesh || c.brush || !(c.light || c.camera)) continue;
    const m = ctx.scene.matrices.get(entity.id);
    if (!m) continue;
    const point: Vec3 = [m[12], m[13], m[14]];
    const at = ctx.project(point);
    if (!at) continue;
    const distance = Math.hypot(at[0] - x, at[1] - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = {
        entity: entity.id,
        face: -1,
        point,
        normal: [0, 1, 0],
        depth: 0,
      };
    }
  }
  return best;
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Turn a viewport-relative pick into a world point on the ground when the
 * pointer hits nothing; handy for placing things. */
export function groundPoint(
  ctx: ViewportContext,
  x: number,
  y: number,
): Vec3 | null {
  return ctx.planePoint(x, y);
}
