import { specialized_editor_descriptor } from "@ink/authoring/catalog.ts";
import {
  editor_preset_id,
  editor_tool_id,
  specialized_editor_id,
} from "@ink/authoring/identity.ts";

export const shooter_presets = [
  {
    id: editor_preset_id("boomer"),
    label: "Boomer shooter",
    summary: "Fast keys, secrets, and crowds.",
    characteristic_mechanics: ["weapon cycling", "keyed doors", "secrets"],
  },
  {
    id: editor_preset_id("arena"),
    label: "Arena shooter",
    summary: "Mobile combat in bounded arenas.",
    characteristic_mechanics: ["movement combat", "pickup routes", "waves"],
  },
  {
    id: editor_preset_id("tactical"),
    label: "Tactical shooter",
    summary: "Deliberate breaches and lethal sightlines.",
    characteristic_mechanics: ["cover", "limited ammunition", "objectives"],
  },
  {
    id: editor_preset_id("horde"),
    label: "Horde shooter",
    summary: "Escalating enemy waves and fortification.",
    characteristic_mechanics: ["waves", "defense", "upgrades"],
  },
  {
    id: editor_preset_id("immersive-sim"),
    label: "Immersive sim",
    summary: "Interlocking spaces with several solutions.",
    characteristic_mechanics: ["systems", "alternate routes", "consequences"],
  },
] as const;

export const shooter_editor = specialized_editor_descriptor({
  id: specialized_editor_id("shooter"),
  label: "Shooter",
  summary: "Author combat spaces, arsenals, encounters, and objectives.",
  vocabulary: [
    "room",
    "cover",
    "spawn",
    "weapon",
    "encounter",
    "door",
    "objective",
  ],
  tools: [
    "rooms",
    "cover",
    "spawns",
    "weapons",
    "encounters",
    "doors",
    "objectives",
  ].map((name) => ({
    id: editor_tool_id(name),
    label: name[0].toUpperCase() + name.slice(1),
    purpose: `Author shooter ${name}.`,
  })),
  presets: shooter_presets,
});
