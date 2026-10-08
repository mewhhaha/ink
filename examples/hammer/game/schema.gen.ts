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

export type IoEvent = "on_pressed" | "on_start_touch" | "on_end_touch" | "on_opened" | "on_closed" | "on_trigger" | "on_hit_max";

export type IoInput = "open" | "close" | "toggle" | "turn_on" | "turn_off" | "trigger" | "increment" | "reset" | "enable" | "disable" | "end_level";

export type Connection = {
  event: IoEvent;
  target: number;
  input: IoInput;
  delay: number;
  once: boolean;
  fired: boolean;
};

export type Pending = {
  time: number;
  source: number;
  index: number;
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

export type Outputs = {
  connections: Connection[];
};

export type Player = {
  speed: number;
  jump: number;
  gravity: number;
  reach: number;
  yaw: number;
  pitch: number;
  velocity: [number, number, number];
  grounded: boolean;
};

export type PushButton = {
  reach: number;
  radius: number;
  cooldown: number;
  wait: number;
  locked: boolean;
};

export type TriggerZone = {
  enabled: boolean;
  inside: boolean;
};

export type Door = {
  offset: [number, number, number];
  speed: number;
  progress: number;
  goal: number;
  origin: [number, number, number];
};

export type Lamp = {
  on: boolean;
  brightness: number;
};

export type Relay = {
  enabled: boolean;
};

export type Counter = {
  count: number;
  max: number;
};

export type Marker = Record<string, never>;

export type Game = {
  finished: boolean;
  focus: number;
  presses: number;
};

export type Wiring = {
  queue: Pending[];
};

export type Components = {
  transform: Transform;
  mesh: Mesh;
  camera: Camera;
  light: Light;
  environment: Environment;
  brush: Brush;
  emitter: Emitter;
  animation: Animation;
  attachment: Attachment;
  outputs: Outputs;
  player: Player;
  push_button: PushButton;
  trigger_zone: TriggerZone;
  door: Door;
  lamp: Lamp;
  relay: Relay;
  counter: Counter;
  marker: Marker;
};

export type Resources = {
  game: Game;
  wiring: Wiring;
};

export type Entity = Omit<InkEntity, "components"> & { components: Partial<Components> };
export type World = Omit<InkWorld, "entities" | "resources"> & { entities: Entity[]; resources: Resources };

export type Actions = {
  move: [number, number];
  turn: [number, number];
  jump: { down: boolean; pressed: boolean; released: boolean };
  press: { down: boolean; pressed: boolean; released: boolean };
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
} } | { name: "io"; value: {
  source: number;
  event: number;
  target: number;
  input: number;
  delay: number;
} };

export const messages = {
  level_finished: 1,
  pressed: 2,
  presses_hud: 3,
  stop_hud: 4,
  press_hud: 5,
} as const;
export type Message = keyof typeof messages;
export const names = {} as const;
export const schemaHash = 540697;
