/**
 * The contract between the import pipeline (Deno) and the renderer/player
 * (browser): extension names, the importer version baked into every cache key,
 * and the shapes both sides pass around. Free of runtime dependencies.
 */

/** Bump when an importer's output changes; it is part of every cache key. */
export const IMPORTER_VERSION = 1;

/** glTF extension carrying simplified index buffers that share a primitive's
 * vertex buffer: `{ levels: [{ indices: accessor, error: number }] }`. `error`
 * is the geometric error in the mesh's local units. */
export const LOD_EXTENSION = "INK_mesh_lods";
export const MESHOPT_EXTENSION = "EXT_meshopt_compression";
export const BASISU_EXTENSION = "KHR_texture_basisu";

export type AssetKind = "mesh" | "texture" | "sound";
/** `preview` is ready within seconds and small; `full` is the final quality. */
export type ImportStage = "preview" | "full";
export type ImportState =
  | "queued"
  | "importing"
  | "ready"
  | "skipped"
  | "failed";

export interface ImportSettings {
  /** Sources smaller than this are served unchanged. */
  minBytes: number;
  textures: {
    /** `size` favours ETC1S everywhere, `quality` UASTC everywhere,
     * `balanced` uses ETC1S for colour and UASTC for normal/data maps. */
    mode: "size" | "balanced" | "quality";
    /** Largest side kept in the final texture. */
    maxSize: number;
    /** Largest side of the quickly produced preview texture. */
    previewSize: number;
  };
  meshes: {
    /** Primitives with fewer vertices keep lossless float attributes. */
    quantizeAbove: number;
    /** Build simplified levels for primitives with at least this many
     * triangles (never for skinned or morphed primitives). */
    lodAbove: number;
    /** Fraction of the previous level's triangles kept by each level. */
    lodRatios: number[];
  };
}

export const DEFAULT_SETTINGS: ImportSettings = {
  minBytes: 512 * 1024,
  textures: { mode: "balanced", maxSize: 4096, previewSize: 256 },
  meshes: {
    quantizeAbove: 2048,
    lodAbove: 3000,
    lodRatios: [0.5, 0.25, 0.25, 0.25],
  },
};

export interface ImportStatus {
  /** Catalog path relative to the assets directory. */
  path: string;
  kind: AssetKind;
  state: ImportState;
  /** The stage being produced, or the best stage available once ready. */
  stage: ImportStage;
  /** Which stages have finished. */
  done: ImportStage[];
  /** 0..1 progress of the running stage. */
  progress: number;
  /** Source content hash (also the thumbnail cache key). */
  source?: string;
  sourceBytes: number;
  /** Bytes of the best finished output. */
  outputBytes?: number;
  /** Wall time of each finished stage in ms, from start to cache write. */
  ms: Partial<Record<ImportStage, number>>;
  message?: string;
  /** glTF material names, for the material browser. */
  materials?: string[];
}
