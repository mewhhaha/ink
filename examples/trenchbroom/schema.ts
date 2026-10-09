import {
  axis2,
  button,
  component,
  defineSchema,
  enumOf,
  f32,
  standard,
  u32,
  vec3,
} from "@ink/schema";

export default defineSchema({
  components: {
    ...standard.components,
    player: component({
      speed: f32({ default: 7, min: 0, max: 30, unit: "m/s" }),
      jump: f32({ default: 7.5, min: 0, max: 30, unit: "m/s" }),
      gravity: f32({ default: 24, min: 0, max: 80, unit: "m/s²" }),
      yaw: f32({
        unit: "rad",
        description: "Facing at the start of the game (0 looks down -Z).",
      }),
      pitch: f32({ readonly: true, group: "State" }),
      origin: vec3({ readonly: true, group: "State" }),
    }, {
      icon: "hand",
      category: "Gameplay",
      description:
        "info_player_start: the first-person body. WASD, mouse look, Space jumps, left click fires. It moves through its capsule collider and character components.",
    }),
    first_person: component({
      eye: f32({
        default: 1.2,
        min: 0,
        max: 3,
        unit: "m",
        description: "Eye height above the player's origin.",
      }),
      bob: f32({ default: 0.035, min: 0, max: 0.3, unit: "m" }),
      phase: f32({ readonly: true, group: "State" }),
    }, {
      icon: "camera",
      category: "Gameplay",
      description: "Attaches this camera to the player's eyes.",
    }),
    pickup: component({
      kind: enumOf(["health", "ammo"], { name: "PickupKind" }),
      amount: f32({ default: 25, min: 1, max: 200 }),
      radius: f32({ default: 1, min: 0.1, unit: "m" }),
      base: f32({ readonly: true, group: "State" }),
    }, {
      icon: "sparkle",
      category: "Gameplay",
      description: "Collected on touch. Spins and bobs.",
    }),
    door: component({
      slide: vec3({
        default: [0, 3.2, 0],
        description: "How far the door moves when open.",
      }),
      reach: f32({
        default: 3.5,
        min: 0.5,
        unit: "m",
        description: "Opens when the player is this close.",
      }),
      speed: f32({
        default: 2.5,
        min: 0.1,
        description: "Opening speed in doors per second.",
      }),
      open: f32({ readonly: true, group: "State" }),
      origin: vec3({ readonly: true, group: "State" }),
    }, {
      icon: "door",
      category: "Gameplay",
      description: "A brush that slides open when the player is near.",
    }),
    hazard: component({
      dps: f32({ default: 18, min: 0, unit: "hp/s" }),
    }, {
      icon: "bolt",
      category: "Gameplay",
      description:
        "A brush you can walk through that hurts. It does not block.",
    }),
    breakable: component({
      health: f32({ default: 3, min: 1 }),
    }, {
      icon: "box",
      category: "Gameplay",
      description: "A brush that breaks after enough hits.",
    }),
  },
  resources: {
    ...standard.resources,
    stats: {
      health: f32({ default: 100 }),
      ammo: u32({ default: 12 }),
      found: u32({ readonly: true }),
      total: u32({ readonly: true }),
      broken: u32({ readonly: true }),
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
    fire: button("MouseLeft"),
  },
  messages: {
    health: "Health +{0}",
    ammo: "Ammo +{0}",
    door: "The door opens",
    hurt: "Acid! Health {0}",
    died: "You died. Back to the start.",
    shot: "Bang ({0} left)",
    empty: "Click. Out of ammo.",
    smashed: "Smashed a crate",
    items_hud: "Items {0} / {1}",
  },
  locales: {
    pl: {
      health: "Zdrowie +{0}",
      ammo: "Amunicja +{0}",
      door: "Drzwi otwarte",
      hurt: "Kwas! Zdrowie {0}",
      died: "Koniec życia. Powrót na start.",
      shot: "Strzał (pozostało {0})",
      empty: "Brak amunicji.",
      smashed: "Skrzynia rozbita",
      items_hud: "Przedmioty {0} / {1}",
    },
  },
});
