import {
  axis2,
  bool,
  button,
  component,
  defineSchema,
  entity,
  f32,
  standard,
  u32,
  vec3,
} from "@ink/schema";

export default defineSchema({
  components: {
    ...standard.components,
    player: component({
      speed: f32({ default: 6, min: 0, max: 30, unit: "m/s" }),
      jump: f32({ default: 7, min: 0, max: 30, unit: "m/s" }),
      gravity: f32({ default: 20, min: 0, max: 80, unit: "m/s²" }),
      velocity: vec3({ readonly: true, group: "State" }),
      grounded: bool({ readonly: true, group: "State" }),
    }, {
      icon: "hand",
      category: "Gameplay",
      description:
        "Moves with WASD and jumps with Space, relative to the camera.",
    }),
    coin: component({
      value: u32({ default: 1, min: 1 }),
      radius: f32({ default: 0.8, min: 0.1, unit: "m" }),
    }, {
      icon: "sparkle",
      category: "Gameplay",
      description: "Collected when the player touches it.",
    }),
    spinner: component({
      speed: f32({ default: 2, min: -20, max: 20, unit: "rad/s" }),
      bob: f32({ default: 0.15, min: 0, max: 2, unit: "m" }),
      base: f32({ group: "State", readonly: true }),
    }, {
      icon: "rotate",
      category: "Gameplay",
      description: "Turns about +Y and bobs up and down.",
    }),
    mover: component({
      offset: vec3({ default: [0, 0, 4] }),
      period: f32({ default: 4, min: 0.1, unit: "s" }),
      origin: vec3({ group: "State", readonly: true }),
      started: bool({ group: "State", readonly: true }),
    }, {
      icon: "move",
      category: "Gameplay",
      description: "Moves back and forth between its start and start + offset.",
    }),
    platform: component({
      size: vec3({ default: [3, 0.5, 3] }),
    }, {
      icon: "box",
      category: "Gameplay",
      description: "A box the player can stand on (centred on the transform).",
    }),
    daylight: component({
      speed: f32({
        default: 0,
        min: -90,
        max: 90,
        step: 1,
        unit: "°/s",
        description: "How fast the sun crosses the sky; 0 holds it.",
      }),
      axis: vec3({
        default: [0.35, 0, 1],
        description: "The sun turns about this world axis.",
      }),
    }, {
      icon: "sun",
      category: "Gameplay",
      description:
        "Turns this entity's light about an axis: a day/night cycle.",
    }),
    follow: component({
      target: entity({ description: "Entity the camera follows." }),
      distance: f32({ default: 9, min: 1, max: 50 }),
      height: f32({ default: 4.5, min: -10, max: 30 }),
      stiffness: f32({ default: 6, min: 0.1, max: 30 }),
    }, {
      icon: "camera",
      category: "Gameplay",
      description: "Keeps this camera behind and above its target.",
    }),
  },
  resources: {
    score: { value: u32(), total: u32({ readonly: true }) },
    debug: {
      paths: bool({
        description: "Draw a line from the player to the nearest coin.",
      }),
    },
  },
  events: { ...standard.events },
  actions: {
    move: axis2({
      left: ["KeyA", "ArrowLeft"],
      right: ["KeyD", "ArrowRight"],
      down: ["KeyS", "ArrowDown"],
      up: ["KeyW", "ArrowUp"],
    }),
    jump: button("Space"),
    restart: button("KeyR"),
  },
  messages: {
    coin: "Coin! {0} of {1}",
    won: "All {0} coins collected",
    score_hud: "● {0} / {1}",
  },
  locales: {
    pl: {
      coin: "Moneta! {0} z {1}",
      won: "Zebrano wszystkie monety: {0}",
      score_hud: "● {0} / {1}",
    },
  },
});
