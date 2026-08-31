import type {
  RoleplayingActor,
  RoleplayingProject,
  RoleplayingRegion,
  RoleplayingTimelineBeat,
} from "@ink/roleplaying-editor/model.ts";
import type { RoleplayingRegionId } from "@ink/roleplaying-editor/identity.ts";
import {
  parse_roleplaying_project,
  serialize_roleplaying_project,
} from "@ink/roleplaying-editor/serialization.ts";
import {
  create_timeline,
  timeline_id,
  timeline_track_id,
  traverse_timeline_events,
} from "@ink/timeline/timeline.ts";

export interface CompiledRoleplayingProject {
  readonly blot_source: string;
  readonly canonical_source: string;
}

export function compile_roleplaying_project(
  source: string,
): CompiledRoleplayingProject {
  const project = parse_roleplaying_project(source);
  const initial_region = required_region(project, project.initial_region_id);
  const player = required_one(
    project.actors.filter((actor): actor is Extract<RoleplayingActor, {
      readonly role: "player";
    }> => actor.role === "player"),
    `role-playing project ${project.id} player`,
  );
  const dialogue = required_one(
    project.dialogue.filter((candidate) => {
      const speaker = project.actors.find(({ id }) =>
        id === candidate.speaker_id
      );
      return speaker?.region_id === initial_region.id &&
        speaker.role === "nonplayer";
    }),
    `role-playing project ${project.id} initial nonplayer dialogue`,
  );
  const speaker = required_one(
    project.actors.filter(({ id }) => id === dialogue.speaker_id),
    `role-playing dialogue ${dialogue.id} speaker`,
  );
  const ruins_link = required_one(
    project.travel_links.filter((link) =>
      link.from_region_id === initial_region.id &&
      link.availability.type === "after_dialogue" &&
      link.availability.dialogue_id === dialogue.id
    ),
    `role-playing project ${project.id} dialogue-gated ruins travel link`,
  );
  const ruins_region = required_region(project, ruins_link.to_region_id);
  const encounter = required_one(
    project.encounters.filter(({ region_id }) => region_id === ruins_region.id),
    `role-playing region ${ruins_region.id} encounter`,
  );
  const sentinel_id = required_one(
    encounter.enemy_actor_ids,
    `role-playing encounter ${encounter.id} enemy actor`,
  );
  const sentinel = required_one(
    project.actors.filter((actor): actor is Extract<RoleplayingActor, {
      readonly role: "enemy";
    }> => actor.id === sentinel_id && actor.role === "enemy"),
    `role-playing encounter ${encounter.id} enemy ${sentinel_id}`,
  );
  const sentinel_region = required_region(project, sentinel.region_id);
  const loot = required_one(
    project.loot.filter((candidate) =>
      candidate.region_id === ruins_region.id &&
      candidate.availability.type === "after_encounter" &&
      candidate.availability.encounter_id === encounter.id
    ),
    `role-playing encounter ${encounter.id} guarded loot`,
  );
  const loot_entry = loot.entries.at(-1);
  if (loot_entry === undefined) {
    throw new Error(`role-playing loot ${loot.id} has no entries to collect`);
  }
  const quest = required_one(
    project.quests.filter((candidate) =>
      candidate.completion.type === "deliver_loot" &&
      candidate.completion.loot_id === loot.id
    ),
    `role-playing loot ${loot.id} delivery quest`,
  );
  if (quest.completion.type !== "deliver_loot") {
    throw new Error(
      `role-playing quest ${quest.id} completion ${quest.completion.type} must deliver loot`,
    );
  }
  const shrine_region = required_region(
    project,
    quest.completion.region_id,
  );
  const shrine_link = required_one(
    project.travel_links.filter((link) =>
      link.from_region_id === ruins_region.id &&
      link.to_region_id === shrine_region.id &&
      link.availability.type === "after_loot" &&
      link.availability.loot_id === loot.id
    ),
    `role-playing loot ${loot.id} gated shrine travel link`,
  );
  const timeline = compile_roleplaying_timeline(project);
  const dialogue_beat = required_timeline_beat(
    timeline,
    "dialogue",
    dialogue.id,
  );
  const ruins_travel_beat = required_timeline_beat(
    timeline,
    "travel",
    ruins_link.id,
  );
  const encounter_beat = required_timeline_beat(
    timeline,
    "encounter",
    encounter.id,
  );
  const loot_beat = required_timeline_beat(timeline, "loot", loot.id);
  const shrine_travel_beat = required_timeline_beat(
    timeline,
    "travel",
    shrine_link.id,
  );
  const quest_beat = required_timeline_beat(timeline, "quest", quest.id);
  const pilgrimage_beats = [
    dialogue_beat,
    ruins_travel_beat,
    encounter_beat,
    loot_beat,
    shrine_travel_beat,
    quest_beat,
  ];
  if (timeline.beats.length !== pilgrimage_beats.length) {
    throw new Error(
      `role-playing timeline ${project.timeline.id} beat count ${timeline.beats.length} must be ${pilgrimage_beats.length}`,
    );
  }
  for (const [expected_order, beat] of pilgrimage_beats.entries()) {
    if (beat.order !== expected_order) {
      throw new Error(
        `role-playing timeline ${project.timeline.id} ${beat.type} beat ${beat.reference} order ${beat.order} must be ${expected_order}`,
      );
    }
  }

  return Object.freeze({
    blot_source: compile_blot_project({
      project,
      initial_region,
      ruins_region,
      shrine_region,
      initial_region_index: region_index(project, initial_region.id),
      ruins_region_index: region_index(project, ruins_region.id),
      shrine_region_index: region_index(project, shrine_region.id),
      player,
      player_region_index: region_index(project, player.region_id),
      speaker,
      dialogue_id: dialogue.id,
      dialogue_text: dialogue.lines.join("\n"),
      encounter_id: encounter.id,
      sentinel,
      sentinel_region,
      sentinel_region_index: region_index(project, sentinel.region_id),
      loot_id: loot.id,
      loot_entry,
      quest_id: quest.id,
      quest_objective: quest.objective,
      timeline_duration_us: timeline.duration_us,
      dialogue_beat,
      ruins_travel_beat,
      encounter_beat,
      loot_beat,
      shrine_travel_beat,
      quest_beat,
    }),
    canonical_source: serialize_roleplaying_project(project),
  });
}

interface RoleplayingBlotProject {
  readonly project: RoleplayingProject;
  readonly initial_region: RoleplayingRegion;
  readonly ruins_region: RoleplayingRegion;
  readonly shrine_region: RoleplayingRegion;
  readonly initial_region_index: number;
  readonly ruins_region_index: number;
  readonly shrine_region_index: number;
  readonly player: Extract<RoleplayingActor, { readonly role: "player" }>;
  readonly player_region_index: number;
  readonly speaker: RoleplayingActor;
  readonly dialogue_id: string;
  readonly dialogue_text: string;
  readonly encounter_id: string;
  readonly sentinel: Extract<RoleplayingActor, { readonly role: "enemy" }>;
  readonly sentinel_region: RoleplayingRegion;
  readonly sentinel_region_index: number;
  readonly loot_id: string;
  readonly loot_entry: string;
  readonly quest_id: string;
  readonly quest_objective: string;
  readonly timeline_duration_us: number;
  readonly dialogue_beat: CompiledRoleplayingBeat;
  readonly ruins_travel_beat: CompiledRoleplayingBeat;
  readonly encounter_beat: CompiledRoleplayingBeat;
  readonly loot_beat: CompiledRoleplayingBeat;
  readonly shrine_travel_beat: CompiledRoleplayingBeat;
  readonly quest_beat: CompiledRoleplayingBeat;
}

function compile_blot_project(compiled: RoleplayingBlotProject): string {
  return `open import "blot:prelude"

const RoleplayingProject = {
  .runtime_token = Int;
  .project_name = Text;
  .quest_id = Text;
  .quest_objective = Text;
  .initial_region_label = Text;
  .ruins_region_label = Text;
  .shrine_region_label = Text;
  .initial_region = Int;
  .ruins_region = Int;
  .shrine_region = Int;
  .player_label = Text;
  .player_region = Int;
  .player_maximum_health = Int;
  .player_attack_damage = Int;
  .speaker_label = Text;
  .dialogue_id = Text;
  .dialogue_text = Text;
  .encounter_id = Text;
  .sentinel_label = Text;
  .sentinel_region_label = Text;
  .sentinel_region = Int;
  .sentinel_maximum_health = Int;
  .sentinel_attack_damage = Int;
  .loot_id = Text;
  .loot_entry = Text;
  .timeline_duration_us = Int;
  .dialogue_beat_order = Int;
  .dialogue_beat_time_us = Int;
  .ruins_travel_beat_order = Int;
  .ruins_travel_beat_time_us = Int;
  .encounter_beat_order = Int;
  .encounter_beat_time_us = Int;
  .loot_beat_order = Int;
  .loot_beat_time_us = Int;
  .shrine_travel_beat_order = Int;
  .shrine_travel_beat_time_us = Int;
  .quest_beat_order = Int;
  .quest_beat_time_us = Int;
}

const project :: Int -> RoleplayingProject
const project = fn runtime_token => {
  .runtime_token = runtime_token;
  .project_name = ${blot_text_literal(compiled.project.name)};
  .quest_id = ${blot_text_literal(compiled.quest_id)};
  .quest_objective = ${blot_text_literal(compiled.quest_objective)};
  .initial_region_label = ${blot_text_literal(compiled.initial_region.label)};
  .ruins_region_label = ${blot_text_literal(compiled.ruins_region.label)};
  .shrine_region_label = ${blot_text_literal(compiled.shrine_region.label)};
  .initial_region = ${compiled.initial_region_index};
  .ruins_region = ${compiled.ruins_region_index};
  .shrine_region = ${compiled.shrine_region_index};
  .player_label = ${blot_text_literal(compiled.player.label)};
  .player_region = ${compiled.player_region_index};
  .player_maximum_health = ${compiled.player.maximum_health};
  .player_attack_damage = ${compiled.player.attack_damage};
  .speaker_label = ${blot_text_literal(compiled.speaker.label)};
  .dialogue_id = ${blot_text_literal(compiled.dialogue_id)};
  .dialogue_text = ${blot_text_literal(compiled.dialogue_text)};
  .encounter_id = ${blot_text_literal(compiled.encounter_id)};
  .sentinel_label = ${blot_text_literal(compiled.sentinel.label)};
  .sentinel_region_label = ${blot_text_literal(compiled.sentinel_region.label)};
  .sentinel_region = ${compiled.sentinel_region_index};
  .sentinel_maximum_health = ${compiled.sentinel.maximum_health};
  .sentinel_attack_damage = ${compiled.sentinel.attack_damage};
  .loot_id = ${blot_text_literal(compiled.loot_id)};
  .loot_entry = ${blot_text_literal(compiled.loot_entry)};
  .timeline_duration_us = ${compiled.timeline_duration_us};
  .dialogue_beat_order = ${compiled.dialogue_beat.order};
  .dialogue_beat_time_us = ${compiled.dialogue_beat.time_us};
  .ruins_travel_beat_order = ${compiled.ruins_travel_beat.order};
  .ruins_travel_beat_time_us = ${compiled.ruins_travel_beat.time_us};
  .encounter_beat_order = ${compiled.encounter_beat.order};
  .encounter_beat_time_us = ${compiled.encounter_beat.time_us};
  .loot_beat_order = ${compiled.loot_beat.order};
  .loot_beat_time_us = ${compiled.loot_beat.time_us};
  .shrine_travel_beat_order = ${compiled.shrine_travel_beat.order};
  .shrine_travel_beat_time_us = ${compiled.shrine_travel_beat.time_us};
  .quest_beat_order = ${compiled.quest_beat.order};
  .quest_beat_time_us = ${compiled.quest_beat.time_us};
}

return { .project = project; }
`;
}

interface CompiledRoleplayingBeat {
  readonly type: RoleplayingTimelineBeat["type"];
  readonly reference: string;
  readonly order: number;
  readonly time_us: number;
}

interface CompiledRoleplayingTimeline {
  readonly beats: readonly CompiledRoleplayingBeat[];
  readonly duration_us: number;
}

function compile_roleplaying_timeline(
  project: RoleplayingProject,
): CompiledRoleplayingTimeline {
  const final_beat = project.timeline.beats.at(-1);
  if (final_beat === undefined) {
    throw new Error(
      `role-playing timeline ${project.timeline.id} has no beats`,
    );
  }
  const beat_by_event_name = new Map<string, RoleplayingTimelineBeat>();
  const events = project.timeline.beats.map((beat, index) => {
    const name = `beat:${String(index).padStart(12, "0")}:${beat.type}`;
    beat_by_event_name.set(name, beat);
    return {
      time: beat.time_us,
      name,
      payload: timeline_beat_reference(beat),
    };
  });
  const timeline = create_timeline({
    id: timeline_id(project.timeline.id),
    duration: final_beat.time_us,
    playback: "once",
    tracks: [{
      type: "events",
      id: timeline_track_id(`${project.timeline.id}.beats`),
      events,
    }],
  });
  const traversed = traverse_timeline_events(timeline, 0, timeline.duration);
  const beats = traversed.map((event, order) => {
    const beat = beat_by_event_name.get(event.name);
    if (beat === undefined) {
      throw new Error(
        `role-playing timeline ${project.timeline.id} produced unknown event ${event.name}`,
      );
    }
    const reference = timeline_beat_reference(beat);
    if (event.payload !== reference) {
      throw new Error(
        `role-playing timeline ${project.timeline.id} event ${event.name} payload ${
          JSON.stringify(event.payload)
        } must be ${JSON.stringify(reference)}`,
      );
    }
    return Object.freeze({
      type: beat.type,
      reference,
      order,
      time_us: event.occurrence_time,
    });
  });
  if (beats.length !== project.timeline.beats.length) {
    throw new Error(
      `role-playing timeline ${project.timeline.id} traversed ${beats.length} of ${project.timeline.beats.length} beats`,
    );
  }
  return Object.freeze({
    beats: Object.freeze(beats),
    duration_us: timeline.duration,
  });
}

function timeline_beat_reference(beat: RoleplayingTimelineBeat): string {
  switch (beat.type) {
    case "dialogue":
      return beat.dialogue_id;
    case "travel":
      return beat.travel_link_id;
    case "encounter":
      return beat.encounter_id;
    case "loot":
      return beat.loot_id;
    case "quest":
      return beat.quest_id;
  }
}

function required_timeline_beat(
  timeline: CompiledRoleplayingTimeline,
  type: RoleplayingTimelineBeat["type"],
  reference: string,
): CompiledRoleplayingBeat {
  return required_one(
    timeline.beats.filter((beat) =>
      beat.type === type && beat.reference === reference
    ),
    `role-playing timeline ${type} beat ${reference}`,
  );
}

function region_index(
  project: RoleplayingProject,
  region_id: RoleplayingRegionId,
): number {
  const index = project.regions.findIndex(({ id }) => id === region_id);
  if (index === -1) {
    throw new Error(
      `role-playing project ${project.id} has no region ${region_id}`,
    );
  }
  return index;
}

function required_region(
  project: RoleplayingProject,
  region_id: RoleplayingRegionId,
): RoleplayingRegion {
  const region = project.regions.find(({ id }) => id === region_id);
  if (region === undefined) {
    throw new Error(
      `role-playing project ${project.id} has no region ${region_id}`,
    );
  }
  return region;
}

function required_one<Entry>(
  entries: readonly Entry[],
  label: string,
): Entry {
  if (entries.length !== 1) {
    throw new Error(`${label} count ${entries.length} must be 1`);
  }
  return entries[0];
}

function blot_text_literal(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
