import {
  axis,
  bool,
  button,
  component,
  defineSchema,
  entity,
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
    mesh: standard.mesh,
    camera: standard.camera,
    light: standard.light,
    environment: standard.environment,
    runner: component({
      player: u32({
        default: 0,
        group: "Body",
        description:
          "Player who controls this runner (0 or 1 in a two-player room)",
      }),
      run_speed: tuning("Run", { default: 8, min: 1, max: 20, unit: "m/s" }),
      ground_accel: tuning("Run", {
        default: 80,
        min: 5,
        max: 300,
        unit: "m/s²",
      }),
      friction: tuning("Run", { default: 70, min: 5, max: 300, unit: "m/s²" }),
      air_accel: tuning("Run", { default: 40, min: 0, max: 300, unit: "m/s²" }),
      jump_speed: tuning("Jump", { default: 13, min: 2, max: 30, unit: "m/s" }),
      jump_cut: tuning("Jump", {
        default: 0.45,
        min: 0.05,
        max: 1,
        description: "Upward speed kept when jump is released early",
      }),
      rise_gravity: tuning("Gravity", {
        default: 34,
        min: 2,
        max: 150,
        unit: "m/s²",
      }),
      fall_gravity: tuning("Gravity", {
        default: 62,
        min: 2,
        max: 200,
        unit: "m/s²",
      }),
      max_fall: tuning("Gravity", {
        default: 24,
        min: 2,
        max: 60,
        unit: "m/s",
      }),
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
      size: vec2({ default: [0.8, 1.2], group: "Body" }),
      velocity: vec2({ readonly: true, group: "State" }),
      grounded: bool({ readonly: true, group: "State" }),
      coyote_left: f32({ readonly: true, group: "State" }),
      buffer_left: f32({ readonly: true, group: "State" }),
      spawn: vec2({ readonly: true, group: "State" }),
    }, {
      icon: "hand",
      category: "Gameplay",
      description:
        "A side-view runner. Every number here is live while playing.",
    }),
    solid: component({
      size: vec2({ default: [4, 1] }),
    }, {
      icon: "box",
      category: "Gameplay",
      description:
        "An axis-aligned box the runner collides with (centred on the transform).",
    }),
    goal: component({
      radius: f32({ default: 0.8, min: 0.1 }),
    }, {
      icon: "sparkle",
      category: "Gameplay",
      description: "Touch it to finish the run.",
    }),
    squash: component({
      amount: f32({
        default: 0.03,
        min: 0,
        max: 0.2,
        description: "Stretch per m/s of vertical speed",
      }),
    }, {
      icon: "scale",
      category: "Juice",
      description:
        "Squashes and stretches this mesh with its parent runner's motion.",
    }),
    follow: component({
      target: entity(),
      lookahead: f32({ default: 2.5, min: 0, max: 10 }),
      height: f32({ default: 2, min: -10, max: 10 }),
      smoothing: f32({ default: 5, min: 0.5, max: 30 }),
    }, {
      icon: "camera",
      category: "Gameplay",
      description: "Keeps this camera on the runner, a little ahead of it.",
    }),
  },
  resources: {
    run: {
      jumps: u32({ readonly: true }),
      time: f32({ readonly: true, unit: "s" }),
      finished: bool({ readonly: true }),
    },
  },
  events: { ...standard.events },
  actions: {
    move: axis(["KeyA", "ArrowLeft"], ["KeyD", "ArrowRight"]),
    jump: button("Space", "KeyW", "ArrowUp"),
  },
  messages: {
    goal: "Goal in {0} s with {1} jumps",
    fell: "Fell — back to the start",
    goal_hud: "Goal!",
  },
  locales: {
    pl: {
      goal: "Cel w {0} s, skoki: {1}",
      fell: "Upadek — powrót na start",
      goal_hud: "Cel!",
    },
  },
});
