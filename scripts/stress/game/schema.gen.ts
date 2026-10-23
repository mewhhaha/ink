// Generated from schema.ts by Ink. Regenerate with `ink gen`; do not edit.
import type {
  EntityModel as InkEntity,
  InputModel as InkInput,
  WorldModel as InkWorld,
} from "@ink/schema";

export type AlphaMode = "opaque" | "mask" | "blend" | "additive";

export type LightKind = "directional" | "point" | "spot";

export type SkyKind = "procedural" | "gradient" | "flat";

export type Tonemap = "aces" | "agx" | "neutral" | "reinhard" | "linear";

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

export type Body = {
  velocity: [number, number, number];
  spin: number;
  bounce: number;
};

export type Components = {
  transform: Transform;
  mesh: Mesh;
  camera: Camera;
  light: Light;
  environment: Environment;
  body: Body;
};

export type Resources = Record<never, never>;

export type Entity = Omit<InkEntity, "components"> & {
  components: Partial<Components>;
};
export type World = Omit<InkWorld, "entities" | "resources"> & {
  entities: Entity[];
  resources: Resources;
};

export type Actions = Record<never, never>;
export type Input = Omit<InkInput, "actions"> & { actions: Actions };

export type Event = {
  name: "particles";
  value: {
    emitter: number;
    position: [number, number, number];
    count: number;
    seed: number;
  };
} | {
  name: "log";
  value: {
    message: number;
    a: number;
    b: number;
  };
} | {
  name: "line";
  value: {
    start: [number, number, number];
    end: [number, number, number];
    color: [number, number, number, number];
  };
} | {
  name: "sound";
  value: {
    clip: number;
    volume: number;
    pitch: number;
    position: [number, number, number];
    spatial: boolean;
  };
};

export const messages = {} as const;
export type Message = keyof typeof messages;
export const names = {} as const;
export const schemaHash = 3185232;
