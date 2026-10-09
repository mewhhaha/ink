/**
 * Public types of the renderer. Colours handed to the renderer (component
 * colours, `Line.color`, overlay colours) are sRGB 0..1 like CSS; shading is
 * done in linear light and the final pass encodes sRGB.
 */
import type { Aabb, Mat4, MeshData, Vec2, Vec3, Vec4 } from "@ink/geometry";
import type { AnimationPose, Model, ModelMaterial } from "./model.ts";

/** Mesh data as the GPU wants it: the geometry plus optional per-vertex extras
 * (used by brushes for face colours and face ids). */
export interface RenderMeshData extends MeshData {
  /** Optional second texture-coordinate set and up to eight skin influences. */
  uvs1?: Float32Array;
  joints?: Uint32Array;
  weights?: Float32Array;
  joints1?: Uint32Array;
  weights1?: Float32Array;
  /** Local-space deltas, evaluated before skinning. */
  targets?: { positions?: Float32Array; normals?: Float32Array }[];
  /** rgba per vertex (sRGB). Defaults to white. */
  colors?: Float32Array;
  /** Brush face index per vertex; omitted for ordinary meshes. */
  faces?: Uint32Array;
}

/** A mesh component resolved to catalog paths, a material and a world matrix. */
export interface Draw {
  /** Include this mesh in static light baking and reflection probes. */
  bakeLighting?: boolean;
  /** Stable sub-object identity for temporal motion (imported glTF nodes). */
  motionKey?: string;
  animation?: AnimationPose;
  /** Read the imported primitive's material (mesh components default to true). */
  useMaterials?: boolean;
  /** Resolved by model expansion, in mesh-local space. */
  skin?: Mat4[];
  morphWeights?: number[];
  material?: ModelMaterial;
  entity: number;
  /** Catalog path such as `models/coin.glb` or `builtin:cube`. */
  mesh: string;
  /** Base colour texture (sRGB). */
  texture?: string;
  matrix: Mat4;
  color: Vec4;
  roughness: number;
  metallic: number;
  emissive: Vec4;
  /** HDR multiplier of `emissive`; above 1 the surface glows into bloom. */
  emissiveStrength: number;
  /** Tangent-space normal map (OpenGL, +Y up); loaded as linear data. */
  normalMap?: string;
  normalStrength: number;
  /** Occlusion (R), roughness (G), metallic (B); loaded as linear data and
   * multiplied with the scalar values. */
  ormMap?: string;
  uvScale: Vec2;
  castShadows: boolean;
  alphaMode?: "opaque" | "mask" | "blend" | "additive";
  alphaCutoff?: number;
  doubleSided?: boolean;
}

/** One texture group of a brush; drawn as an ordinary instanced mesh. UVs are
 * in texels, the view divides by the texture size. */
export interface BrushPart {
  key: string;
  texture?: string;
  mesh: RenderMeshData;
}

/** Everything derived from a brush's faces; shared between draws and scenes
 * whose faces are identical. */
export interface BrushGeometry {
  key: string;
  parts: BrushPart[];
  /** Unique edges in local space. */
  edges: [Vec3, Vec3][];
  /** Polygon of every face (aligned with the face list; empty if degenerate). */
  polygons: Vec3[][];
  /** Local-space bounds. */
  bounds: Aabb;
}

export interface BrushDraw {
  /** Static lighting receiver/caster. Disable for moving doors/platforms. */
  bakeLighting?: boolean;
  entity: number;
  matrix: Mat4;
  geometry: BrushGeometry;
}

export interface LightDraw {
  entity: number;
  kind: "directional" | "point" | "spot";
  /** sRGB. */
  color: Vec3;
  intensity: number;
  range: number;
  /** Full cone angle in degrees (spot lights). */
  angle: number;
  shadows: boolean;
  /** Light size for soft shadows (penumbra scale); 0 is a hard edge. */
  softness: number;
  position: Vec3;
  /** Direction the light travels (its world -Z). */
  direction: Vec3;
}

export interface ReflectionProbe {
  entity: number;
  matrix: Mat4;
  size: Vec3;
  blend: number;
  intensity: number;
}

export interface CameraSettings {
  fov: number;
  near: number;
  far: number;
  orthographic: boolean;
  size: number;
}

export interface SceneCamera {
  entity: number;
  matrix: Mat4;
  camera: CameraSettings & { active: boolean };
}

/** Rendering quality. `low` skips bloom and auto exposure and uses cheaper
 * shadow filtering: for editor side views and software rasterizers. */
export type Quality = "low" | "high";

export type SkyKind = "procedural" | "gradient" | "flat";
export type TonemapKind = "aces" | "agx" | "neutral" | "reinhard" | "linear";

/** The standard `environment` component, resolved. Colours are sRGB 0..1. */
export interface Environment {
  sky: SkyKind;
  /** Zenith (gradient) or the whole sky (flat). */
  skyColor: Vec4;
  horizonColor: Vec4;
  groundColor: Vec4;
  skyIntensity: number;
  /** Altitude of world zero above sea level, metres. Camera height is added. */
  skyAltitude: number;
  cloudCoverage: number;
  cloudHeight: number;
  cloudScale: number;
  cloudOffset: number;
  /** Strength of the sky's light on every surface. */
  ambient: number;
  /** Strength of path-traced static bounce lighting; 0 disables baking. */
  indirect: number;
  /** Screen-space reflections: 0 disables, 1 fully replaces visible probe hits. */
  reflections: number;
  ambientOcclusion: number;
  aoRadius: number;
  shadowDistance: number;
  /** Manual exposure in EV (stops). */
  exposure: number;
  autoExposure: boolean;
  tonemap: TonemapKind;
  /** Mix of the bloom image into the picture, 0..1. */
  bloom: number;
  contrast: number;
  saturation: number;
  temperature: number;
  vignette: number;
  grain: number;
  fogDensity: number;
  /** sRGB. Alpha 0 means automatic: a procedural sky tints the fog, any other
   * sky uses this colour. */
  fogColor: Vec4;
  /** Fog thins out above this height. */
  fogHeight: number;
  fogFalloff: number;
}

export interface RenderScene {
  probes?: ReflectionProbe[];
  /** Optional simulation tick, used to discard temporal history on a seek. */
  tick?: number;
  /** Tick-derived particle batches; all simulation and sorting run in compute. */
  particles?: ParticleDraw[];
  /** World matrix of every entity (those without a transform inherit their
   * parent's). */
  matrices: Map<number, Mat4>;
  draws: Draw[];
  brushes: BrushDraw[];
  lights: LightDraw[];
  cameras: SceneCamera[];
  /** The first active `environment` component, or the defaults. */
  environment: Environment;
  /** Bounds of all geometry (unknown mesh files count as unit cubes; the view
   * refines this with loaded mesh bounds). */
  bounds: Aabb | null;
}

export interface ParticleDraw {
  entity: number;
  matrix: Mat4;
  seed: number;
  /** Seconds since the emitter started, or since this burst. */
  time: number;
  /** Zero for a burst; positive for continuous local-space emission. */
  rate: number;
  count: number;
  lifetime: number;
  velocity: Vec3;
  spread: Vec3;
  gravity: Vec3;
  radius: number;
  size: Vec2;
  color: Vec4;
  endColor: Vec4;
  intensity: number;
  blend: "blend" | "additive";
  shape: "soft" | "spark";
  texture?: string;
}

export interface Camera {
  view: Mat4;
  projection: Mat4;
  position: Vec3;
  near: number;
  far: number;
  orthographic: boolean;
}

export interface Line {
  from: Vec3;
  to: Vec3;
  color: Vec4;
  /** CSS pixels, default 1. */
  width?: number;
  /** Hide behind geometry. Default false. */
  depthTest?: boolean;
}

export interface Overlays {
  /** Accumulate jittered frames with motion/depth rejection. Stills bypass it. */
  temporal?: boolean;
  /** Internal raster size relative to the output, clamped to 0.5..1. */
  renderScale?: number;
  /** Explicit camera cut or discontinuous presentation change. */
  resetHistory?: boolean;
  grid?: false | {
    plane: "xz" | "xy" | "yz";
    spacing: number;
    /** Every n-th line is a major line (default 10). */
    major?: number;
  };
  lines?: Line[];
  selection?: readonly number[];
  hovered?: number;
  selectedFaces?: readonly { entity: number; face: number }[];
  shading?: "lit" | "unlit" | "wireframe";
  /** Draw brush edges (the editor look). */
  edges?: boolean;
  /** Flat clear colour; by default a sky gradient (perspective) is drawn. */
  background?: Vec4;
  /** Overrides the hemisphere ambient light colour (sky side, sRGB); the
   * ground side is derived from it. */
  ambient?: Vec4;
  /** Per-view overrides of the scene's environment (exposure, tonemap...). */
  environment?: Partial<Environment>;
  /** Default: the renderer's quality (`low` on software rasterizers). */
  quality?: Quality;
  /** Disable clustered light culling for reference renders and profiling. */
  clustered?: boolean;
  /** Render a still picture: animated grain and dither are frozen and auto
   * exposure converges at once, so the same scene, camera and options always
   * give the same pixels. Captures and hand-off screenshots use it. */
  still?: boolean;
  /** Tuning views: tint the shadow cascades, show the ambient occlusion
   * buffer, or draw the shadow maps as insets. */
  debug?: "cascades" | "ao" | "shadow-atlas";
}

export interface Pick {
  entity: number;
  /** Brush face index, -1 unless the hit is a brush face. */
  face: number;
  point: Vec3;
  normal: Vec3;
  /** Raw 0..1 clip-space depth of the hit. */
  depth: number;
}

export interface PixelData {
  width: number;
  height: number;
  /** RGBA8, row-major, top row first. */
  data: Uint8Array;
}

export interface AssetStore {
  readonly version: number;
  modelData(path: string): Model | undefined;
  /** Base URL that asset paths resolve against, e.g. "/assets/". */
  base: string;
  preload(kind: "mesh" | "texture", path: string): void;
  reload(path: string): void;
  setMesh(key: string, data: RenderMeshData): void;
  /** Register raw RGBA8 (sRGB) pixels as a texture; for procedural textures
   * and runtimes without image decoding. */
  setTexture(
    path: string,
    image: { width: number; height: number; data: Uint8Array },
  ): void;
  /** Resolves when all loads started so far have finished or failed. */
  settled(): Promise<void>;
  onChange(listener: () => void): () => void;
  textureSize(path: string): [number, number] | undefined;
  /** Approximate linear RGB average for diffuse lighting bakes. */
  textureColor(path: string): Vec3 | undefined;
  /** CPU geometry for picking/snapping once loaded. Treat as immutable. */
  meshData(path: string): RenderMeshData | undefined;
}

export interface View {
  /** Size in device pixels. */
  readonly width: number;
  readonly height: number;
  /** Counters of the last frame, for tools and tests. */
  readonly stats: {
    lightmapSamples: number;
    lightmapCharts: number;
    reflectionProbes: number;
    pendingWork: boolean;
    passes: number;
    environmentBakes: number;
    lights: number;
    clusters: number;
    particles: number;
    temporalFrames: number;
    renderWidth: number;
    renderHeight: number;
  };
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void;
  render(scene: RenderScene, camera: Camera, overlays?: Overlays): void;
  pick(x: number, y: number): Promise<Pick | null>;
  capture(): Promise<Blob>;
  /** Raw RGBA8 pixels of the last rendered frame. */
  readPixels(): Promise<PixelData>;
  dispose(): void;
}

export interface Renderer {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly assets: AssetStore;
  createView(
    target: HTMLCanvasElement | OffscreenCanvas | {
      width: number;
      height: number;
    },
  ): View;
  readonly lost: Promise<GPUDeviceLostInfo>;
  dispose(): void;
}
