// Generated from schema.ts by Ink. Regenerate with `ink gen`; do not edit.
import type { EntityModel as InkEntity, InputModel as InkInput, WorldModel as InkWorld } from "@ink/schema";

export type SkyKind = "procedural" | "gradient" | "flat";

export type Tonemap = "aces" | "agx" | "neutral" | "reinhard" | "linear";

export type Light2dKind = "lamp" | "spotlight" | "sun" | "ambient";

export type TextAlign = "left" | "center" | "right";

export type HudSlot = "coins" | "time" | "banner" | "detail" | "hint";

export type Transform = {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
};

export type Camera = {
  fov: number;
  near: number;
  far: number;
  orthographic: boolean;
  size: number;
  active: boolean;
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

export type Sprite = {
  atlas: number;
  frame: number;
  anim: number;
  anim_time: number;
  texture: number;
  color: [number, number, number, number];
  flip_x: boolean;
  flip_y: boolean;
  pivot: [number, number];
  pixels_per_unit: number;
  layer: number;
  y_sort: boolean;
  lit: boolean;
  smooth: boolean;
  snap: boolean;
};

export type Tilemap = {
  tileset: number;
  width: number;
  height: number;
  cell: [number, number];
  color: [number, number, number, number];
  layer: number;
  lit: boolean;
  occluder: boolean;
  cells: number[];
};

export type Light2d = {
  kind: Light2dKind;
  color: [number, number, number, number];
  intensity: number;
  radius: number;
  falloff: number;
  height: number;
  angle: number;
  shadows: boolean;
};

export type Text = {
  message: number;
  a: number;
  b: number;
  size: number;
  color: [number, number, number, number];
  align: TextAlign;
  outline: number;
  outline_color: [number, number, number, number];
  layer: number;
};

export type Hero = {
  run_speed: number;
  ground_accel: number;
  friction: number;
  air_accel: number;
  jump_speed: number;
  jump_cut: number;
  rise_gravity: number;
  fall_gravity: number;
  max_fall: number;
  coyote: number;
  buffer: number;
  climb_speed: number;
  size: [number, number];
  velocity: [number, number];
  grounded: boolean;
  climbing: boolean;
  facing: number;
  coyote_left: number;
  buffer_left: number;
  drop_left: number;
  spawn: [number, number];
};

export type Coin = {
  radius: number;
};

export type Slime = {
  speed: number;
  direction: number;
  size: [number, number];
};

export type Goal = {
  radius: number;
};

export type Follow = {
  target: number;
  smoothing: number;
  lookahead: number;
  min: [number, number];
  max: [number, number];
};

export type Terrain = {
  kill_below: number;
};

export type Flicker = {
  base: number;
  amount: number;
  speed: number;
};

export type Hud = {
  slot: HudSlot;
};

export type Game = {
  coins: number;
  total: number;
  deaths: number;
  time: number;
  finished: boolean;
};

export type Components = {
  transform: Transform;
  camera: Camera;
  environment: Environment;
  sprite: Sprite;
  tilemap: Tilemap;
  light2d: Light2d;
  text: Text;
  hero: Hero;
  coin: Coin;
  slime: Slime;
  goal: Goal;
  follow: Follow;
  terrain: Terrain;
  flicker: Flicker;
  hud: Hud;
};

export type Resources = {
  game: Game;
};

export type Entity = Omit<InkEntity, "components"> & { components: Partial<Components> };
export type World = Omit<InkWorld, "entities" | "resources"> & { entities: Entity[]; resources: Resources };

export type Actions = {
  move: number;
  climb: number;
  jump: { down: boolean; pressed: boolean; released: boolean };
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
  coins_hud: 1,
  time_hud: 2,
  clear: 3,
  clear_detail: 4,
  hint: 5,
  ouch: 6,
} as const;
export type Message = keyof typeof messages;
export const names = {} as const;
export const schemaHash = 16495685;
