/** React panels for brush editing: toolbar, face inspector, texture browser. */
import { type ReactElement, useMemo, useRef } from "react";
import { type BrushFace, brushPolygons } from "@ink/geometry";
import type { Transaction } from "@ink/core";
import type { Node, Value, WorldModel } from "@ink/schema";
import {
  FieldRows,
  Icon,
  jsonEqual,
  ToolPicker,
  useInk,
  useSession,
  useSessionValue,
  useStore,
  useUi,
  type ViewportTool,
} from "@ink/react";
import { alignFace, fitFace, surfaceOf, withSurface } from "./edit.ts";
import {
  brushDefaults,
  clipState,
  type FaceRef,
  faceSelection,
  useFaceSelection,
} from "./state.ts";
import { brushTools } from "./tools.ts";

/** The brush tools as toolbar buttons (the built-in select/move/rotate/scale
 * stay in `<ToolPicker>`). */
export function BrushToolbar(
  { tools = brushTools }: { tools?: ViewportTool[] },
): ReactElement {
  return <ToolPicker tools={tools} builtins={false} />;
}

const HINTS: Record<string, string> = {
  block: "Drag in a view to draw a brush",
  "brush-edit": "2D views: drag handles to resize, drag inside to move",
  clip: "Click two points in a 2D view",
  "brush-face": "Click faces in the 3D view (Shift adds, Ctrl the whole brush)",
};

/** A one-line hint for the active brush tool, including the clip mode. */
export function BrushHint(): ReactElement | null {
  const tool = useUi((u) => u.tool) as string;
  const clip = useStore(clipState, (s) => s);
  const hint = HINTS[tool];
  if (!hint) return null;
  if (tool === "clip" && clip.points === 2) {
    return (
      <span className="ink-status">
        Keep {clip.keep} (Tab) · Enter applies · Esc cancels
      </span>
    );
  }
  return <span className="ink-status">{hint}</span>;
}

const brushFacesOf = (
  world: WorldModel,
  entity: number,
): BrushFace[] | undefined =>
  (world.entities.find((e) => e.id === entity)?.components.brush as {
    faces: BrushFace[];
  } | undefined)?.faces;

/** Live edits that become one undo step when `final` is true. */
function useTransaction() {
  const session = useSession();
  const tx = useRef<Transaction | null>(null);
  return (
    label: string,
    recipe: Parameters<Transaction["update"]>[0],
    final: boolean,
  ) => {
    if (!final) {
      tx.current ??= session.begin(label);
      tx.current.update(recipe);
    } else if (tx.current) {
      tx.current.update(recipe);
      tx.current.commit();
      tx.current = null;
    } else {
      session.edit(label, recipe);
    }
  };
}

function useTextureTools() {
  const ink = useInk();
  const catalog = useSessionValue((s) => s.catalog);
  return {
    textures: catalog.assets.texture ?? [],
    url: (path: string) =>
      ink.dev?.client.assetUrl(path) ?? `/__ink/assets/${path}`,
    size: (id: number): [number, number] => {
      const path = catalog.assets.texture?.[id - 1];
      return (path && ink.renderer?.assets.textureSize(path)) || [64, 64];
    },
  };
}

/** The Face struct's fields without the plane: the surface. */
function surfaceFields(node: Node | undefined) {
  if (!node || node.kind !== "list" || node.element.kind !== "struct") {
    return [];
  }
  return node.element.fields.filter((f) => f.name !== "plane");
}

/**
 * Surface of the selected faces (see `useFaceSelection`): texture, colour,
 * offset, scale and rotation, edited on every selected face at once, plus fit
 * and align buttons. Edits are live and one undo step each.
 */
export function FaceInspector(): ReactElement {
  const session = useSession();
  const refs = useFaceSelection();
  const tools = useTextureTools();
  const edit = useTransaction();
  const schema = useSessionValue((s) => s.schema);
  const live = useSessionValue(
    (s) => refs.filter((r) => brushFacesOf(s.world, r.entity)?.[r.face]),
    jsonEqual,
  );
  const first = useSessionValue((s) => {
    const r = live[0];
    const face = r && brushFacesOf(s.world, r.entity)?.[r.face];
    return face ? surfaceOf(face) : undefined;
  }, jsonEqual);
  const fields = useMemo(
    () =>
      surfaceFields(
        schema.component("brush")?.fields.find((f) => f.name === "faces")?.node,
      ),
    [schema],
  );

  if (!first || live.length === 0) {
    return (
      <div className="ink-empty">
        Select faces with the face tool (T), or Ctrl-click to take a whole
        brush. Shift adds to the selection.
      </div>
    );
  }
  const brushes = new Set(live.map((r) => r.entity)).size;

  const each = (
    label: string,
    change: (
      face: BrushFace,
      polygon: ReturnType<typeof brushPolygons>[number],
      ref: FaceRef,
    ) => BrushFace,
    final = true,
  ) =>
    edit(label, (world) => {
      for (const ref of live) {
        const faces = brushFacesOf(world, ref.entity);
        if (!faces?.[ref.face]) continue;
        const polygon = brushPolygons(faces.map((f) => f.plane))[ref.face];
        faces[ref.face] = change(faces[ref.face], polygon, ref);
      }
    }, final);

  const button = (
    text: string,
    title: string,
    run: () => void,
    icon?: string,
  ) => (
    <button type="button" className="ink-button" title={title} onClick={run}>
      {icon && <Icon name={icon} size={12} />} {text}
    </button>
  );

  return (
    <div className="ink-inspector">
      <div className="ink-inspector-head">
        <Icon name="layers" size={16} style={{ color: "var(--ink-muted)" }} />
        <span className="ink-panel-title" style={{ flex: 1 }}>
          {live.length === 1 ? "Face" : `${live.length} faces`}
        </span>
        <span className="ink-chip">
          {brushes === 1
            ? session.nameOf(live[0].entity)
            : `${brushes} brushes`}
        </span>
        <button
          type="button"
          className="ink-button"
          data-icon-only="true"
          title="Deselect faces"
          onClick={() => faceSelection.clear()}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <section className="ink-section">
        <div className="ink-section-body">
          <FieldRows
            fields={fields}
            value={first as unknown as Record<string, Value>}
            onChange={(next, final) => {
              const keys = Object.keys(next).filter((k) =>
                JSON.stringify((first as Record<string, unknown>)[k]) !==
                  JSON.stringify(next[k])
              );
              each("Edit face", (face) => {
                const copy = face as unknown as Record<string, unknown>;
                for (const key of keys) copy[key] = structuredClone(next[key]);
                return copy as unknown as BrushFace;
              }, final);
            }}
          />
        </div>
      </section>
      <section className="ink-section">
        <div className="ink-section-body">
          <div
            className="ink-field-wide"
            style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
          >
            {button("Fit", "Scale the texture to cover each face once", () =>
              each(
                "Fit texture",
                (f, poly) => fitFace(f, poly, tools.size(f.texture)),
              ), "maximize")}
            {button("Align", "Move the texture origin to the face corner", () =>
              each("Align texture", (f, poly) =>
                alignFace(f, poly)), "magnet")}
            {button("Reset", "Offset 0, scale 1, rotation 0", () =>
              each(
                "Reset texture",
                (f) => ({ ...f, offset: [0, 0], scale: [1, 1], rotation: 0 }),
              ), "undo")}
          </div>
          <div
            className="ink-field-wide"
            style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
          >
            {button("-90°", "Rotate the texture", () =>
              each(
                "Rotate texture",
                (f) => ({ ...f, rotation: (f.rotation - 90) % 360 }),
              ), "rotate")}
            {button("+90°", "Rotate the texture", () =>
              each(
                "Rotate texture",
                (f) => ({ ...f, rotation: (f.rotation + 90) % 360 }),
              ), "rotate")}
            {button("Flip X", "Mirror the texture horizontally", () =>
              each(
                "Flip texture",
                (f) => ({ ...f, scale: [-f.scale[0], f.scale[1]] }),
              ))}
            {button("Flip Y", "Mirror the texture vertically", () =>
              each(
                "Flip texture",
                (f) => ({ ...f, scale: [f.scale[0], -f.scale[1]] }),
              ))}
          </div>
          <div
            className="ink-field-wide"
            style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
          >
            {button(
              "Copy to brush",
              "Give every face of these brushes this surface",
              () =>
                edit("Copy surface", (world) => {
                  for (
                    const entity of new Set(live.map((r) =>
                      r.entity
                    ))
                  ) {
                    const faces = brushFacesOf(world, entity);
                    if (faces) {
                      faces.forEach((
                        f,
                        i,
                      ) => (faces[i] = withSurface(f, first)));
                    }
                  }
                }, true),
              "copy",
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * The project's textures. Click to apply one to the selected faces, or to every
 * face of the selected brushes; with nothing selected it becomes the texture of
 * new brushes. Shift-click always sets the texture of new brushes.
 */
export function TextureBrowser(): ReactElement {
  const session = useSession();
  const tools = useTextureTools();
  const defaults = useStore(brushDefaults, (s) => s);
  const faces = useFaceSelection();
  const catalog = useSessionValue((s) => s.catalog);
  const apply = (path: string, shift: boolean) => {
    const id = (catalog.assets.texture ?? []).indexOf(path) + 1;
    const brushes = session.selection.filter((e) =>
      brushFacesOf(session.world, e)
    );
    if (shift || (faces.length === 0 && brushes.length === 0)) {
      brushDefaults.set({ texture: path });
      return;
    }
    session.edit("Apply texture", (world) => {
      if (faces.length) {
        for (const ref of faces) {
          const f = brushFacesOf(world, ref.entity)?.[ref.face];
          if (f) f.texture = id;
        }
      } else {
        for (const entity of brushes) {
          for (const f of brushFacesOf(world, entity) ?? []) {
            f.texture = id;
          }
        }
      }
    });
  };
  const current = new Set<number>();
  for (const ref of faces) {
    const f = brushFacesOf(session.world, ref.entity)?.[ref.face];
    if (f) current.add(f.texture);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        className="ink-assets"
        style={{ overflow: "auto", flex: 1, alignContent: "start" }}
      >
        {tools.textures.length === 0 && (
          <div className="ink-empty" style={{ gridColumn: "1 / -1" }}>
            No textures. Add PNG files to the project's assets folder.
          </div>
        )}
        {tools.textures.map((path, index) => (
          <div
            key={path}
            className="ink-asset"
            aria-selected={current.has(index + 1) || defaults.texture === path}
            title={`${path}\nClick: apply to the selection. Shift-click: texture for new brushes.`}
            style={{ cursor: "pointer" }}
            onClick={(e) => apply(path, e.shiftKey)}
          >
            <div className="ink-asset-thumb">
              <img src={tools.url(path)} alt="" loading="lazy" />
            </div>
            <div className="ink-asset-name">
              {path.split("/").pop()?.replace(/\.[^.]+$/, "")}
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          padding: "4px 8px",
          color: "var(--ink-faint)",
          fontSize: 11,
          borderTop: "1px solid var(--ink-border)",
        }}
      >
        New brushes:{" "}
        {defaults.texture ? defaults.texture.split("/").pop() : "untextured"}
      </div>
    </div>
  );
}
