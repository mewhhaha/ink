// Generated from schema.ts by Ink. Regenerate with `ink gen`; do not edit.
import type { EntityModel as InkEntity, InputModel as InkInput, WorldModel as InkWorld } from "@ink/schema";

export type AlphaMode = "opaque" | "mask" | "blend" | "additive";

export type LightKind = "directional" | "point" | "spot";

export type SkyKind = "procedural" | "gradient" | "flat";

export type Tonemap = "aces" | "agx" | "neutral" | "reinhard" | "linear";

export type Face = {
  plane: [number, number, number, number];
  texture: number;
  color: [number, number, number, number];
  offset: [number, number];
  scale: [number, number];
  rotation: number;
  uv_u: [number, number, number, number];
  uv_v: [number, number, number, number];
};

export type ParticleShape = "soft" | "spark";

export type Transform = {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
};

export type Mesh = {
  shape: number;
  color: [number, number, number, number];
  texture: number;
  roughness: number;
  metallic: number;
  emissive: [number, number, number, number];
  emissive_strength: number;
  normal_map: number;
  normal_strength: number;
  orm_map: number;
  uv_scale: [number, number];
  alpha_mode: AlphaMode;
  alpha_cutoff: number;
  double_sided: boolean;
  cast_shadows: boolean;
};

export type Camera = {
  fov: number;
  near: number;
  far: number;
  orthographic: boolean;
  size: number;
  active: boolean;
};

export type Light = {
  kind: LightKind;
  color: [number, number, number, number];
  intensity: number;
  range: number;
  angle: number;
  shadows: boolean;
  softness: number;
};

export type Environment = {
  active: boolean;
  sky: SkyKind;
  sky_color: [number, number, number, number];
  horizon_color: [number, number, number, number];
  ground_color: [number, number, number, number];
  sky_intensity: number;
  sky_altitude: number;
  cloud_coverage: number;
  cloud_height: number;
  cloud_scale: number;
  cloud_offset: number;
  ambient: number;
  ambient_occlusion: number;
  ao_radius: number;
  shadow_distance: number;
  exposure: number;
  auto_exposure: boolean;
  tonemap: Tonemap;
  bloom: number;
  contrast: number;
  saturation: number;
  temperature: number;
  vignette: number;
  grain: number;
  fog_density: number;
  fog_color: [number, number, number, number];
  fog_height: number;
  fog_falloff: number;
};

export type Brush = {
  visible: boolean;
  faces: Face[];
};

export type Emitter = {
  active: boolean;
  seed: number;
  start_tick: number;
  rate: number;
  lifetime: number;
  velocity: [number, number, number];
  spread: [number, number, number];
  gravity: [number, number, number];
  radius: number;
  size: [number, number];
  color: [number, number, number, number];
  end_color: [number, number, number, number];
  intensity: number;
  additive: boolean;
  shape: ParticleShape;
  texture: number;
};

export type Player = {
  speed: number;
  jump: number;
  gravity: number;
  velocity: [number, number, number];
  grounded: boolean;
};

export type Coin = {
  value: number;
  radius: number;
};

export type Spinner = {
  speed: number;
  bob: number;
  base: number;
};

export type Mover = {
  offset: [number, number, number];
  period: number;
  origin: [number, number, number];
  started: boolean;
};

export type Platform = {
  size: [number, number, number];
};

export type Daylight = {
  speed: number;
  axis: [number, number, number];
};

export type Follow = {
  target: number;
  distance: number;
  height: number;
  stiffness: number;
};

export type Score = {
  value: number;
  total: number;
};

export type Debug = {
  paths: boolean;
};

export type Components = {
  transform: Transform;
  mesh: Mesh;
  camera: Camera;
  light: Light;
  environment: Environment;
  brush: Brush;
  emitter: Emitter;
  player: Player;
  coin: Coin;
  spinner: Spinner;
  mover: Mover;
  platform: Platform;
  daylight: Daylight;
  follow: Follow;
};

export type Resources = {
  score: Score;
  debug: Debug;
};

export type Entity = Omit<InkEntity, "components"> & { components: Partial<Components> };
export type World = Omit<InkWorld, "entities" | "resources"> & { entities: Entity[]; resources: Resources };

export type Actions = {
  move: [number, number];
  jump: { down: boolean; pressed: boolean; released: boolean };
  restart: { down: boolean; pressed: boolean; released: boolean };
};
export type Input = Omit<InkInput, "actions"> & { actions: Actions };

export type Event = { name: "particles"; value: {
  emitter: number;
  position: [number, number, number];
  count: number;
  seed: number;
} } | { name: "log"; value: {
  message: number;
  a: number;
  b: number;
} } | { name: "line"; value: {
  start: [number, number, number];
  end: [number, number, number];
  color: [number, number, number, number];
} } | { name: "sound"; value: {
  clip: number;
  volume: number;
  pitch: number;
  position: [number, number, number];
  spatial: boolean;
} };

export const messages = {
  coin: 1,
  won: 2,
  score_hud: 3,
} as const;
export type Message = keyof typeof messages;
export const names = {} as const;
export const schemaHash = 1529481;
