import { asset_id } from "@ink/assets/identity.ts";
import { parse_blot_indexed_seed } from "@ink/ecs/blot.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import { create_catalog } from "@ink/localization/catalog.ts";
import { Localizer } from "@ink/localization/localizer.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  agent_profile_id,
  navigation_area_id,
} from "@ink/navigation/identity.ts";
import { create_agent_profile } from "@ink/navigation/profile.ts";
import type { RoleplayingProject } from "@ink/roleplaying-editor/model.ts";
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
import {
  flatten_semantic_tree,
  literal_text,
  type SemanticNode,
  ui_id,
  UiSnapshotStore,
} from "@ink/ui/semantic.ts";
import { cell_id, level_id, world_id } from "@ink/world/identity.ts";
import { create_authored_partition } from "@ink/world/partition.ts";

export interface CompiledRoleplayingProject {
  readonly blot_source: string;
  readonly canonical_source: string;
  readonly loot_count: number;
  readonly route_count: number;
}

export function compile_roleplaying_project(
  source: string,
): CompiledRoleplayingProject {
  const project = parse_roleplaying_project(source);
  const keeper_dialogue = project.dialogue.find(({ speaker_id }) =>
    speaker_id === "keeper"
  );
  const ruins_loot = project.loot.find(({ region_id }) =>
    region_id === "ruins"
  );
  const shrine = project.regions.find(({ id }) =>
    id === project.shrine_region_id
  );
  if (
    keeper_dialogue === undefined || ruins_loot === undefined ||
    shrine === undefined
  ) {
    throw new Error(
      `role-playing project ${project.id} lacks keeper dialogue, ruins loot, or shrine`,
    );
  }
  const catalog = create_catalog({
    locale: "en",
    messages: {
      "keeper.line": [{ type: "parameter", name: "line" }],
    },
  });
  const keeper_line = new Localizer({ catalogs: [catalog], locale: "en" })
    .resolve(
      "keeper.line",
      { line: keeper_dialogue.lines.join(" ") },
    );
  const partition = create_authored_partition({
    world_id: world_id(project.id),
    level_id: level_id("pilgrimage"),
    coordinate_cell_size: 10,
    cells: project.regions.map((region, index) => ({
      id: cell_id(region.id),
      bounds: aabb(vec3(index * 10, 0, 0), vec3(index * 10 + 9, 5, 9)),
      scene_asset: asset_id<"scene">(`regions/${region.id}`),
      estimated_bytes: 1,
      portals: project.navigation.filter(({ from_region_id }) =>
        from_region_id === region.id
      ).map((link) => ({
        id: link.id,
        to: cell_id(link.to_region_id),
      })),
    })),
  });
  const profile = create_agent_profile({
    id: agent_profile_id("hero"),
    radius: 0.4,
    height: 1.8,
    maximum_climb: 0.4,
    maximum_slope_degrees: 45,
    maximum_speed: 6,
    maximum_acceleration: 12,
    area_costs: new Map([[navigation_area_id("road"), 1]]),
  });
  if (profile.type !== "ready") {
    throw new Error(
      `role-playing navigation profile failed: ${profile.reason}`,
    );
  }
  const progress_seed = "0";
  parse_blot_indexed_seed(progress_seed, 1, 1);
  const timeline = create_timeline({
    id: timeline_id("pilgrimage"),
    duration: 6,
    playback: "once",
    tracks: [{
      type: "events",
      id: timeline_track_id("quest-steps"),
      events: ["talk", "travel", "defeat", "collect", "shrine"].map((
        name,
        index,
      ) => ({ time: index + 1, name })),
    }],
  });
  const event_count = traverse_timeline_events(timeline, 0, 6).length;
  const root: SemanticNode = {
    role: "region",
    id: ui_id("roleplaying.quest"),
    label: literal_text(project.name),
    layout: { type: "flex", direction: "column", gap: 4, padding: 8 },
    children: ruins_loot.entries.map((entry, index): SemanticNode => ({
      role: "text",
      id: ui_id(`roleplaying.loot.${index}`),
      label: literal_text(entry),
    })),
  };
  const ui_store = new UiSnapshotStore();
  const accepted = ui_store.replace({
    revision: 0,
    direction: "ltr",
    root,
    announcements: [],
  });
  if (accepted.type === "rejected") {
    throw new Error(`role-playing UI failed: ${accepted.reason}`);
  }
  const node_count = flatten_semantic_tree(accepted.snapshot.root).length;
  const loot_text = ruins_loot.entries.join(", ");
  return Object.freeze({
    blot_source: `return {
  .progress_seed = ${literal(progress_seed)};
  .initial_region = ${
      literal(
        project.regions.find(({ id }) => id === project.initial_region_id)
          ?.label ?? project.initial_region_id,
      )
    };
  .keeper_line = ${literal(keeper_line)};
  .travel_label = ${
      literal(
        `Travel ${partition.cells().length} regions at speed ${profile.profile.maximum_speed}`,
      )
    };
  .loot_text = ${literal(loot_text)};
  .shrine_label = ${literal(shrine.label)};
  .completed_text = ${
      literal(
        `Quest complete with ${loot_text} · ${event_count} timeline steps · ${node_count} semantic nodes`,
      )
    };
}
`,
    canonical_source: serialize_roleplaying_project(project),
    loot_count: ruins_loot.entries.length,
    route_count: partition.cells().length,
  });
}

function literal(value: string): string {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll(
    "\u2029",
    "\\u2029",
  );
}
