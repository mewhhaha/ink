import {
  axis,
  bool,
  button,
  component,
  defineSchema,
  entity,
  enumOf,
  f32,
  standard,
  u32,
  vec2,
} from "@ink/schema";

const tuning = (group: string, options: Parameters<typeof f32>[0]) =>
  f32({ ...options, group });

export default defineSchema({
  components: {
    transform: standard.transform,
    camera: standard.camera,
    environment: standard.environment,
    sprite: standard.sprite,
    tilemap: standard.tilemap,
    light2d: standard.light2d,
    text: standard.text,
    hero: component({
      run_speed: tuning("Run", { default: 7, min: 1, max: 20, unit: "m/s" }),
      ground_accel: tuning("Run", { default: 70, min: 5, max: 300 }),
      friction: tuning("Run", { default: 60, min: 5, max: 300 }),
      air_accel: tuning("Run", { default: 40, min: 0, max: 300 }),
      jump_speed: tuning("Jump", { default: 13.5, min: 2, max: 30 }),
      jump_cut: tuning("Jump", {
        default: 0.45,
        min: 0.05,
        max: 1,
        description: "Upward speed kept when jump is released early",
      }),
      rise_gravity: tuning("Gravity", { default: 38, min: 2, max: 150 }),
      fall_gravity: tuning("Gravity", { default: 64, min: 2, max: 200 }),
      max_fall: tuning("Gravity", { default: 20, min: 2, max: 60 }),
      coyote: tuning("Forgiveness", {
        default: 0.1,
        min: 0,
        max: 0.4,
        unit: "s",
        description: "Jump still allowed this long after leaving a ledge",
      }),
      buffer: tuning("Forgiveness", {
        default: 0.12,
        min: 0,
        max: 0.4,
        unit: "s",
        description: "A jump pressed this early before landing still happens",
      }),
      climb_speed: tuning("Climb", { default: 4.5, min: 0, max: 12 }),
      size: vec2({ default: [0.62, 0.8], group: "Body" }),
      velocity: vec2({ readonly: true, group: "State" }),
      grounded: bool({ readonly: true, group: "State" }),
      climbing: bool({ readonly: true, group: "State" }),
      facing: f32({ default: 1, readonly: true, group: "State" }),
      coyote_left: f32({ readonly: true, group: "State" }),
      buffer_left: f32({ readonly: true, group: "State" }),
      drop_left: f32({ readonly: true, group: "State" }),
      spawn: vec2({ readonly: true, group: "State" }),
    }, {
      icon: "hand",
      category: "Gameplay",
      description:
        "The player: run, jump with coyote time and a jump buffer, climb ladders.",
    }),
    coin: component({
      radius: f32({ default: 0.55, min: 0.1, unit: "m" }),
    }, {
      icon: "sparkle",
      category: "Gameplay",
      description: "Collected on touch.",
    }),
    slime: component({
      speed: f32({ default: 1.6, min: 0, max: 8, unit: "m/s" }),
      direction: f32({ default: -1, readonly: true, group: "State" }),
      size: vec2({ default: [0.7, 0.5], group: "Body" }),
    }, {
      icon: "bolt",
      category: "Gameplay",
      description:
        "Patrols a platform and turns at walls and ledges. Stomp it from above.",
    }),
    goal: component({
      radius: f32({ default: 0.8, min: 0.1, unit: "m" }),
    }, {
      icon: "door",
      category: "Gameplay",
      description: "Touch it to clear the level.",
    }),
    follow: component({
      target: entity(),
      smoothing: f32({ default: 6, min: 0.5, max: 30 }),
      lookahead: f32({ default: 1.5, min: 0, max: 8, unit: "m" }),
      min: vec2({
        default: [-1000, -1000],
        description: "Lowest camera centre",
      }),
      max: vec2({
        default: [1000, 1000],
        description: "Highest camera centre",
      }),
    }, {
      icon: "camera",
      category: "Gameplay",
      description: "Keeps this camera on its target, kept inside the bounds.",
    }),
    terrain: component({
      kill_below: f32({
        default: -4,
        unit: "m",
        description:
          "Falling this far below the map's origin respawns the hero.",
      }),
    }, {
      icon: "layers",
      category: "Gameplay",
      description: "Marks the tile map the hero, slimes and hazards use.",
    }),
    flicker: component({
      base: f32({ default: 1, min: 0 }),
      amount: f32({ default: 0.15, min: 0 }),
      speed: f32({ default: 11, min: 0 }),
    }, {
      icon: "bulb",
      category: "Juice",
      description: "Makes this light2d flicker around a base intensity.",
    }),
    hud: component({
      slot: enumOf(["coins", "time", "banner", "detail", "hint"], {
        name: "HudSlot",
      }),
    }, {
      icon: "comment",
      category: "Gameplay",
      description: "A text entity the game fills in from its state.",
    }),
  },
  resources: {
    game: {
      coins: u32({ readonly: true }),
      total: u32({ readonly: true }),
      deaths: u32({ readonly: true }),
      time: f32({ readonly: true, unit: "s" }),
      finished: bool({ readonly: true }),
    },
  },
  events: { ...standard.events },
  actions: {
    move: axis(["KeyA", "ArrowLeft"], ["KeyD", "ArrowRight"]),
    climb: axis(["KeyS", "ArrowDown"], ["KeyW", "ArrowUp"]),
    jump: button("Space", "KeyZ", "KeyK"),
  },
  messages: {
    coins_hud: "COINS {0}/{1}",
    time_hud: "TIME {0}",
    clear: "LEVEL CLEAR!",
    clear_detail: "{0} COINS IN {1} SECONDS",
    hint: "MOVE A D   JUMP SPACE   CLIMB W S",
    ouch: "OUCH!",
  },
  locales: {
    sv: {
      coins_hud: "MYNT {0}/{1}",
      time_hud: "TID {0}",
      clear: "NIVÅN KLAR!",
      clear_detail: "{0} MYNT PÅ {1} SEKUNDER",
      hint: "GÅ A D   HOPPA SPACE   KLÄTTRA W S",
      ouch: "AJ!",
    },
  },
});
