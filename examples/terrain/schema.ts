import {
  axis2,
  bool,
  button,
  component,
  defineSchema,
  f32,
  standard,
  vec3,
} from "@ink/schema";

export default defineSchema({
  components: {
    ...standard.components,
    ...standard.componentsWorld,
    walker: component({
      speed: f32({ default: 6, min: 0, max: 40, unit: "m/s" }),
      run: f32({
        default: 2,
        min: 1,
        max: 8,
        description: "Speed multiplier while the run button is held.",
      }),
      jump: f32({ default: 6, min: 0, max: 30, unit: "m/s" }),
      gravity: f32({ default: 20, min: 0, max: 80, unit: "m/s²" }),
      max_slope: f32({
        default: 50,
        min: 5,
        max: 85,
        unit: "°",
        description: "Ground steeper than this is too steep to climb.",
      }),
      velocity: vec3({ group: "State", readonly: true }),
      grounded: bool({ group: "State", readonly: true }),
    }, {
      icon: "hand",
      category: "Gameplay",
      description:
        "Walks over the terrain (WASD, Shift to run, Space to jump), standing on the ground height game code reads from the terrain.",
    }),
  },
  events: { ...standard.events },
  actions: {
    move: axis2({
      left: ["KeyA", "ArrowLeft"],
      right: ["KeyD", "ArrowRight"],
      down: ["KeyS", "ArrowDown"],
      up: ["KeyW", "ArrowUp"],
    }),
    run: button("ShiftLeft", "ShiftRight"),
    jump: button("Space"),
  },
  names: { player: "Player" },
});
