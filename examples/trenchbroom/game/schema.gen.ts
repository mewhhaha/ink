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

export type ColliderShape = "box" | "sphere" | "capsule" | "hull";

export type BodyKind = "dynamic" | "kinematic" | "static";

export type PickupKind = "health" | "ammo";

export type ReflectionProbe = {
  size: [number, number, number];
  blend: number;
  intensity: number;
};

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
  use_materials: boolean;
  cast_shadows: boolean;
  bake_lighting: boolean;
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
  reflections: number;
  indirect: number;
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
  bake_lighting: boolean;
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

export type Animation = {
  clip: number;
  time: number;
  loop: boolean;
  previous_clip: number;
  previous_time: number;
  previous_loop: boolean;
  blend: number;
};

export type Attachment = {
  target: number;
  node: number;
};

export type Collider = {
  shape: ColliderShape;
  size: [number, number, number];
  radius: number;
  height: number;
  offset: [number, number, number];
  friction: number;
  restitution: number;
  layer: number;
  mask: number;
  trigger: boolean;
};

export type Body = {
  kind: BodyKind;
  mass: number;
  gravity_scale: number;
  linear_damping: number;
  angular_damping: number;
  can_sleep: boolean;
  continuous: boolean;
  linear_velocity: [number, number, number];
  angular_velocity: [number, number, number];
  sleeping: boolean;
  sleep_time: number;
};

export type Character = {
  max_slope: number;
  step_height: number;
  snap_distance: number;
  push: number;
  velocity: [number, number, number];
  grounded: boolean;
  ground: number;
  ground_normal: [number, number, number];
};

export type Player = {
  speed: number;
  jump: number;
  gravity: number;
  yaw: number;
  pitch: number;
  origin: [number, number, number];
};

export type FirstPerson = {
  eye: number;
  bob: number;
  phase: number;
};

export type Pickup = {
  kind: PickupKind;
  amount: number;
  radius: number;
  base: number;
};

export type Door = {
  slide: [number, number, number];
  reach: number;
  speed: number;
  open: number;
  origin: [number, number, number];
};

export type Hazard = {
  dps: number;
};

export type Breakable = {
  health: number;
};

export type Physics = {
  gravity: [number, number, number];
  substeps: number;
  sleep_time: number;
  linear_sleep: number;
  angular_sleep: number;
  contacts: number[];
};

export type Stats = {
  health: number;
  ammo: number;
  found: number;
  total: number;
  broken: number;
};

export type Components = {
  reflection_probe: ReflectionProbe;
  transform: Transform;
  mesh: Mesh;
  camera: Camera;
  light: Light;
  environment: Environment;
  brush: Brush;
  emitter: Emitter;
  animation: Animation;
  attachment: Attachment;
  collider: Collider;
  body: Body;
  character: Character;
  player: Player;
  first_person: FirstPerson;
  pickup: Pickup;
  door: Door;
  hazard: Hazard;
  breakable: Breakable;
};

export type Resources = {
  physics: Physics;
  stats: Stats;
};

export type Entity = Omit<InkEntity, "components"> & { components: Partial<Components> };
export type World = Omit<InkWorld, "entities" | "resources"> & { entities: Entity[]; resources: Resources };

export type Actions = {
  move: [number, number];
  jump: { down: boolean; pressed: boolean; released: boolean };
  fire: { down: boolean; pressed: boolean; released: boolean };
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
  health: 1,
  ammo: 2,
  door: 3,
  hurt: 4,
  died: 5,
  shot: 6,
  empty: 7,
  smashed: 8,
  items_hud: 9,
} as const;
export type Message = keyof typeof messages;
export const names = {} as const;
export const schemaHash = 9292447;
