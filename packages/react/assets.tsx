/** Browse the project's assets; drag a mesh into a view to place it, click a
 * texture to apply it to the selection. */
import { useState } from "react";
import { useInk, useSession, useSessionValue } from "./context.tsx";
import { Icon } from "./icons.tsx";

const icons: Record<string, string> = {
  mesh: "cube",
  texture: "image",
  sound: "music",
};
export const ASSET_MIME = "application/x-ink-asset";

export function AssetBrowser({ kinds }: { kinds?: string[] }) {
  const ink = useInk();
  const session = useSession();
  const catalog = useSessionValue((s) => s.catalog);
  const available = (kinds ?? Object.keys(catalog.assets)).filter((k) =>
    catalog.assets[k]
  );
  const [kind, setKind] = useState(available[0] ?? "mesh");
  const [query, setQuery] = useState("");
  const paths = (catalog.assets[kind] ?? []).filter((p) =>
    p.toLowerCase().includes(query.toLowerCase())
  );
  const url = (path: string) =>
    ink.dev?.client.assetUrl(path) ?? `/__ink/assets/${path}`;

  const apply = (path: string) => {
    const id = catalog.assets[kind].indexOf(path) + 1;
    if (kind === "texture" && session.selection.length) {
      session.edit("Apply texture", (world) => {
        for (const sel of session.selection) {
          const e = world.entities.find((x) => x.id === sel);
          const mesh = e?.components.mesh;
          if (mesh) mesh.texture = id;
          const brush = e?.components.brush as
            | { faces: { texture: number }[] }
            | undefined;
          if (brush) { for (const face of brush.faces) face.texture = id; }
        }
      });
    } else if (kind === "mesh") {
      session.createEntity({
        name: path.replace(/^builtin:/, "").replace(/\.[^.]+$/, "").split("/")
          .pop(),
        components: {
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          mesh: {
            shape: id,
            color: [1, 1, 1, 1],
            texture: 0,
            roughness: 0.6,
            metallic: 0,
            emissive: [0, 0, 0, 1],
            cast_shadows: true,
          },
        },
      });
    } else if (kind === "sound") {
      new Audio(url(path)).play().catch(() => {});
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{ display: "flex", gap: 2, padding: 6, alignItems: "center" }}
      >
        {available.map((k) => (
          <button
            type="button"
            key={k}
            className="ink-button"
            aria-pressed={k === kind}
            onClick={() => setKind(k)}
          >
            <Icon name={icons[k] ?? "file"} /> {k}
          </button>
        ))}
        <input
          className="ink-input"
          style={{ marginLeft: "auto", maxWidth: 160 }}
          placeholder="Filter"
          value={query}
          onChange={(e) =>
            setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div
        className="ink-assets"
        style={{ overflow: "auto", flex: 1, alignContent: "start" }}
      >
        {paths.length === 0 && (
          <div className="ink-empty" style={{ gridColumn: "1 / -1" }}>
            No {kind} assets. Drop files into the project's assets folder.
          </div>
        )}
        {paths.map((path) => (
          <div
            key={path}
            className="ink-asset"
            draggable
            title={`${path}\n${
              kind === "texture"
                ? "Click: apply to selection"
                : kind === "mesh"
                ? "Click or drag into a view: place it"
                : "Click: listen"
            }`}
            onDragStart={(e) =>
              e.dataTransfer.setData(
                ASSET_MIME,
                JSON.stringify({
                  kind,
                  path,
                  id: catalog.assets[kind].indexOf(path) + 1,
                }),
              )}
            onClick={() => apply(path)}
          >
            <div className="ink-asset-thumb">
              {kind === "texture"
                ? <img src={url(path)} alt="" loading="lazy" />
                : (
                  <Icon
                    name={path.startsWith("builtin:")
                      ? "box"
                      : icons[kind] ?? "file"}
                    size={24}
                  />
                )}
            </div>
            <div className="ink-asset-name">
              {path.replace(/^builtin:/, "").split("/").pop()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
