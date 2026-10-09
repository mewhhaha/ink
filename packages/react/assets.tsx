/** Browse the project's assets; drag a mesh into a view to place it, click a
 * texture to apply it to the selection. */
import { useEffect, useState } from "react";
import type { DevClient } from "@ink/dev/client";
import type { ImportStatus } from "@ink/assets/format";
import { type Renderer, renderThumbnail } from "@ink/render";
import {
  useInk,
  useRenderer,
  useSession,
  useSessionValue,
} from "./context.tsx";
import { Icon } from "./icons.tsx";

const icons: Record<string, string> = {
  mesh: "cube",
  texture: "image",
  sound: "music",
  atlas: "grid",
};
export const ASSET_MIME = "application/x-ink-asset";

/** Import progress of every imported asset, live from the dev server. */
export function useImports(): Map<string, ImportStatus> {
  const client = useInk().dev?.client;
  const [statuses, setStatuses] = useState(new Map<string, ImportStatus>());
  useEffect(() => {
    if (!client) return;
    let alive = true;
    client.imports().then((list) => {
      if (alive) setStatuses(new Map(list.map((s) => [s.path, s])));
    }).catch(() => {});
    const off = client.on("ink:imports", ({ statuses: changed }) => {
      setStatuses((old) => {
        const next = new Map(old);
        for (const s of changed) next.set(s.path, s);
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [client]);
  return statuses;
}

// Thumbnails cached by content: server-side in `.ink/cache`, here as blob URLs.
const thumbnailUrls = new Map<string, Promise<string | null>>();
let drawing: Promise<unknown> = Promise.resolve();

/** The cached thumbnail, or one rendered by the editor's own renderer and
 * stored on the server for next time. One render at a time. */
function thumbnail(
  client: DevClient,
  renderer: Renderer | null,
  path: string,
  variant: string,
  source: string,
  render?: () => Promise<Blob>,
): Promise<string | null> {
  const key = `${path}|${variant}|${source}`;
  let found = thumbnailUrls.get(key);
  if (!found) {
    found = (async () => {
      try {
        const cached = await fetch(client.thumbnailUrl(path, variant, source));
        if (cached.status === 200) {
          return URL.createObjectURL(await cached.blob());
        }
      } catch { /* render below */ }
      if (!render || !renderer) return null;
      const blob =
        await (drawing = drawing.catch(() => {}).then(render)) as Blob;
      client.putThumbnail(path, variant, source, blob).catch(() => {});
      return URL.createObjectURL(blob);
    })().catch(() => null);
    thumbnailUrls.set(key, found);
    found.then((url) => {
      if (!url) thumbnailUrls.delete(key);
    });
  }
  return found;
}

function Thumb({ path, variant, status, spec, fallback }: {
  path: string;
  variant: string;
  status?: ImportStatus;
  spec: "texture" | { mesh: string; material?: number };
  fallback: string;
}) {
  const client = useInk().dev?.client;
  const renderer = useRenderer();
  const [src, setSrc] = useState<string | null>(null);
  const source = status?.source;
  useEffect(() => {
    setSrc(null);
    if (!client || !source) return;
    let alive = true;
    let attempts = 0;
    const load = () => {
      thumbnail(
        client,
        renderer,
        path,
        variant,
        source,
        spec === "texture"
          ? undefined
          : () => renderThumbnail(renderer!, spec, 128),
      ).then((url) => {
        if (!alive) return;
        if (url) setSrc(url);
        else if (spec === "texture" && ++attempts < 8) setTimeout(load, 500);
      });
    };
    load();
    return () => {
      alive = false;
    };
  }, [client, renderer, path, variant, source]);
  return src ? <img src={src} alt="" /> : <Icon name={fallback} size={24} />;
}

function describe(status?: ImportStatus): string {
  if (!status) return "";
  const size = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`;
  if (status.state === "failed") return `Import failed: ${status.message}`;
  if (status.state === "skipped") return "";
  if (status.state === "ready") {
    return `Imported in ${((status.ms.full ?? 0) / 1000).toFixed(1)} s: ${
      size(status.sourceBytes)
    } to ${size(status.outputBytes ?? 0)}`;
  }
  return `${status.stage === "preview" ? "Quick import" : "Compressing"} ${
    Math.round(status.progress * 100)
  }%`;
}

export function AssetBrowser({ kinds }: { kinds?: string[] }) {
  const ink = useInk();
  const session = useSession();
  const catalog = useSessionValue((s) => s.catalog);
  const imports = useImports();
  // Materials come from imported models (one entry per glTF material).
  const materials = [...imports.values()].flatMap((s) =>
    (s.materials ?? []).map((name, index) => ({ path: s.path, name, index }))
  );
  const available = [
    ...(kinds ?? Object.keys(catalog.assets)).filter((k) => catalog.assets[k]),
    ...(materials.length && (!kinds || kinds.includes("material"))
      ? ["material"]
      : []),
  ];
  const [kind, setKind] = useState(available[0] ?? "mesh");
  const [query, setQuery] = useState("");
  const active = [...imports.values()].filter((s) =>
    s.state === "queued" || s.state === "importing"
  );
  const paths = kind === "material"
    ? materials.map((m) => `${m.path}#${m.index}`).filter((p) =>
      p.toLowerCase().includes(query.toLowerCase())
    )
    : (catalog.assets[kind] ?? []).filter((p) =>
      p.toLowerCase().includes(query.toLowerCase())
    );
  const url = (path: string) =>
    ink.dev?.client.assetUrl(path) ?? `/__ink/assets/${path}`;

  const apply = (path: string) => {
    if (kind === "material") return;
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
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 2,
          padding: 6,
          alignItems: "center",
        }}
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
      {active.length > 0 && (
        <div className="ink-import-progress" role="status">
          <div
            className="ink-import-bar"
            style={{
              width: `${
                Math.round(
                  100 * active.reduce((n, s) => n + s.progress, 0) /
                    active.length,
                )
              }%`,
            }}
          />
          <span>
            Importing{" "}
            {active.length === 1 ? active[0].path : `${active.length} assets`}:
            {" "}
            {describe(active[0])}
          </span>
        </div>
      )}
      <div
        className="ink-assets"
        style={{ overflow: "auto", flex: 1, alignContent: "start" }}
      >
        {paths.length === 0 && (
          <div className="ink-empty" style={{ gridColumn: "1 / -1" }}>
            No {kind} assets. Drop files into the project's assets folder.
          </div>
        )}
        {paths.map((path) => {
          const model = kind === "material"
            ? materials.find((m) => `${m.path}#${m.index}` === path)
            : undefined;
          const status = imports.get(model?.path ?? path);
          const state = status?.state;
          return (
            <div
              key={path}
              className="ink-asset"
              draggable={kind !== "material"}
              data-import={state}
              title={`${path}\n${
                kind === "material"
                  ? `Material ${model?.name} of ${model?.path}`
                  : kind === "texture"
                  ? "Click: apply to selection"
                  : kind === "mesh"
                  ? "Click or drag into a view: place it"
                  : "Click: listen"
              }\n${describe(status)}`.trim()}
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
                {path.startsWith("builtin:")
                  ? <Icon name="box" size={24} />
                  : kind === "texture"
                  ? (
                    <Thumb
                      path={path}
                      variant="asset"
                      status={status}
                      spec="texture"
                      fallback="image"
                    />
                  )
                  : kind === "mesh"
                  ? (
                    <Thumb
                      path={path}
                      variant="mesh"
                      status={status}
                      spec={{ mesh: path }}
                      fallback="cube"
                    />
                  )
                  : model
                  ? (
                    <Thumb
                      path={model.path}
                      variant={`material:${model.index}`}
                      status={status}
                      spec={{ mesh: model.path, material: model.index }}
                      fallback="cube"
                    />
                  )
                  : <Icon name={icons[kind] ?? "file"} size={24} />}
                {(state === "queued" || state === "importing") && (
                  <span className="ink-asset-badge">
                    {Math.round((status?.progress ?? 0) * 100)}%
                  </span>
                )}
                {state === "failed" && (
                  <span className="ink-asset-badge" data-failed>!</span>
                )}
              </div>
              <div className="ink-asset-name">
                {model
                  ? model.name
                  : path.replace(/^builtin:/, "").split("/").pop()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
