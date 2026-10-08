/**
 * Entity I/O, Source-style. Every entity may carry `outputs`: a list of
 * connections "when <event> happens here, send <input> to <target> after
 * <delay> seconds". Events and inputs are enums (Blot has no runtime
 * strings); the classes below (button, trigger zone, door, lamp, relay,
 * counter) emit some events and understand some inputs.
 */
import {
  axis2,
  bool,
  button,
  component,
  defineSchema,
  entity,
  enumOf,
  f32,
  list,
  standard,
  struct,
  u32,
  vec3,
} from "@ink/schema";

/** Things an entity can say happened to it. */
export const ioEvents = [
  "on_pressed",
  "on_start_touch",
  "on_end_touch",
  "on_opened",
  "on_closed",
  "on_trigger",
  "on_hit_max",
] as const;

/** Things an entity can be told to do. */
export const ioInputs = [
  "open",
  "close",
  "toggle",
  "turn_on",
  "turn_off",
  "trigger",
  "increment",
  "reset",
  "enable",
  "disable",
  "end_level",
] as const;

export default defineSchema({
  components: {
    ...standard.components,
    outputs: component({
      connections: list(
        struct({
          event: enumOf(ioEvents, {
            name: "IoEvent",
            description: "What happened here.",
          }),
          target: entity({ description: "Entity that receives the input." }),
          input: enumOf(ioInputs, {
            name: "IoInput",
            description: "What the target is told to do.",
          }),
          delay: f32({ min: 0, max: 60, step: 0.1, unit: "s" }),
          once: bool({ description: "Fire only the first time." }),
          fired: bool({ hidden: true }),
        }, { name: "Connection" }),
        { max: 12 },
      ),
    }, {
      icon: "send",
      category: "I/O",
      description:
        "Outputs: when an event happens here, send an input to another entity.",
    }),
    player: component({
      speed: f32({ default: 5, min: 0, max: 20, unit: "m/s" }),
      jump: f32({ default: 6.5, min: 0, max: 20, unit: "m/s" }),
      gravity: f32({ default: 20, min: 0, max: 80, unit: "m/s²" }),
      reach: f32({
        default: 3,
        min: 0,
        max: 10,
        unit: "m",
        description: "How far E presses buttons.",
      }),
      yaw: f32({
        default: 0,
        step: 5,
        unit: "°",
        description: "Initial facing; 0 looks down -Z.",
      }),
      pitch: f32({ readonly: true, group: "State", unit: "°" }),
      velocity: vec3({ readonly: true, group: "State" }),
      grounded: bool({ readonly: true, group: "State" }),
    }, {
      icon: "hand",
      category: "Gameplay",
      description:
        "info_player_start: the first-person body. Its transform is the eye; the camera is its own.",
    }),
    push_button: component({
      reach: f32({ default: 3, min: 0.5, max: 10, unit: "m" }),
      radius: f32({
        default: 0.45,
        min: 0.1,
        max: 2,
        unit: "m",
        description: "Aim tolerance around the entity.",
      }),
      cooldown: f32({ default: 1.5, min: 0, max: 60, unit: "s" }),
      wait: f32({ readonly: true, group: "State", unit: "s" }),
      locked: bool(),
    }, {
      icon: "bolt",
      category: "I/O",
      description:
        "func_button: press with E while looking at it. Fires OnPressed.",
    }),
    trigger_zone: component({
      size: vec3({ default: [4, 3, 4], min: 0.1, unit: "m" }),
      enabled: bool({ default: true }),
      inside: bool({ readonly: true, group: "State" }),
    }, {
      icon: "crosshair",
      category: "I/O",
      description:
        "trigger_multiple: a box region centred on the entity. Fires OnStartTouch and OnEndTouch.",
    }),
    door: component({
      offset: vec3({
        default: [3, 0, 0],
        unit: "m",
        description: "How far it slides when open.",
      }),
      speed: f32({ default: 2, min: 0.1, max: 20, unit: "m/s" }),
      progress: f32({ readonly: true, group: "State" }),
      goal: f32({
        readonly: true,
        group: "State",
        description: "0 closed, 1 open",
      }),
      origin: vec3({ readonly: true, group: "State" }),
    }, {
      icon: "door",
      category: "I/O",
      description:
        "func_door: a brush entity that slides open and closed. Fires OnOpened and OnClosed.",
    }),
    lamp: component({
      on: bool({ default: true }),
      brightness: f32({ default: 6, min: 0, max: 50 }),
    }, {
      icon: "sun",
      category: "I/O",
      description: "light + switch: drives the entity's light and glow.",
    }),
    relay: component({
      enabled: bool({ default: true }),
    }, {
      icon: "send",
      category: "I/O",
      description: "logic_relay: on Trigger, fires OnTrigger.",
    }),
    counter: component({
      count: u32({ readonly: true, group: "State" }),
      max: u32({ default: 2, min: 1, max: 100 }),
    }, {
      icon: "layers",
      category: "I/O",
      description: "logic_counter: on Increment, fires OnHitMax at max.",
    }),
    marker: component({}, {
      icon: "entity",
      category: "I/O",
      description:
        "Editor-only visual: the mesh is removed when the game starts.",
    }),
  },
  resources: {
    game: {
      finished: bool({ readonly: true }),
      focus: entity({
        readonly: true,
        description: "The button under the crosshair.",
      }),
      presses: u32({ readonly: true }),
    },
    wiring: {
      queue: list(
        struct({
          time: f32({ unit: "s" }),
          source: entity(),
          index: u32(),
        }, { name: "Pending" }),
        { max: 48 },
      ),
    },
  },
  events: {
    ...standard.events,
    io: {
      source: entity(),
      event: f32({ description: "Index into ioEvents." }),
      target: entity(),
      input: f32({ description: "Index into ioInputs." }),
      delay: f32(),
    },
  },
  actions: {
    move: axis2({
      left: ["KeyA"],
      right: ["KeyD"],
      down: ["KeyS"],
      up: ["KeyW"],
    }),
    turn: axis2({
      left: ["ArrowLeft"],
      right: ["ArrowRight"],
      down: ["ArrowDown"],
      up: ["ArrowUp"],
    }),
    jump: button("Space"),
    press: button("KeyE"),
  },
  messages: {
    level_finished: "Level complete",
    pressed: "Pressed",
  },
});
