import type { AdventureDocument } from "@ink/adventure-editor/document.ts";
import type { AdventureBrush } from "@ink/adventure-editor/layout.ts";
import {
  agent_profile_id,
  navigation_area_id,
  navigation_obstacle_id,
  navigation_tile_id,
} from "@ink/navigation/identity.ts";
import { NavigationMesh } from "@ink/navigation/navmesh.ts";
import {
  create_agent_profile,
  type NavigationArea,
} from "@ink/navigation/profile.ts";
import { find_navigation_path } from "@ink/navigation/query.ts";
import {
  build_navigation_tile,
  navigation_grid_tile_input,
  navigation_obstacle,
  type NavigationObstacle,
} from "@ink/navigation/tile.ts";
import { rigid_pose } from "@ink/physics/collision.ts";
import { physics_world_id } from "@ink/physics/identity.ts";
import { box_shape } from "@ink/physics/shapes.ts";
import {
  type PhysicsMutationResult,
  PhysicsWorld,
} from "@ink/physics/world.ts";
import { vec3 } from "@ink/math/vector.ts";

const navigation_cell_size = 0.5;
const microunits_per_meter = 1_000_000;
const ground_area: NavigationArea = Object.freeze({
  id: navigation_area_id("adventure-ground"),
  default_cost: 1,
});

export interface AdventureTraversalContract {
  readonly closed_gate: {
    readonly type: "blocked";
    readonly navigation_result: "unavailable" | "unreachable";
    readonly stop_x_microunits: number;
    readonly stop_z_microunits: number;
    readonly physics_contacts: number;
  };
  readonly open_gate: {
    readonly type: "route";
    readonly goal_x_microunits: number;
    readonly goal_z_microunits: number;
    readonly navigation_revision: number;
    readonly path_points: number;
    readonly path_cost_microunits: number;
  };
}

export function compile_adventure_traversal(
  document: AdventureDocument,
): AdventureTraversalContract {
  const gate = bound_brush(document, "unlock-exit");
  const floor = traversal_floor(document, gate);
  const floor_top = floor.elevation + floor.height;
  const start = vec3(
    document.layout.player_start.x2 / 2,
    floor_top,
    document.layout.player_start.z2 / 2,
  );
  const gate_footprint = brush_footprint(gate);
  const goal = vec3(
    gate.center_x2 / 2,
    floor_top,
    gate.center_z2 / 2 + gate_footprint.depth / 2 -
      navigation_cell_size / 2,
  );
  const profile_result = create_agent_profile({
    id: agent_profile_id("adventure-player"),
    radius: 0.2,
    height: 1,
    maximum_climb: 0.25,
    maximum_slope_degrees: 45,
    maximum_speed: 2.8,
    maximum_acceleration: 8,
    area_costs: new Map(),
  });
  if (profile_result.type !== "ready") {
    throw new Error(
      `adventure traversal agent profile failed: ${profile_result.reason}`,
    );
  }
  const profile = profile_result.profile;
  const obstacles = document.layout.brushes
    .filter((brush) => brush.id !== floor.id)
    .map((brush) => brush_obstacle(brush));
  const closed_navigation = build_navigation(
    floor,
    profile,
    obstacles,
    "closed",
  );
  const open_navigation = build_navigation(
    floor,
    profile,
    obstacles.filter(({ id }) => id !== navigation_obstacle_id(gate.id)),
    "open",
  );
  const query_options = {
    profile,
    areas: new Map([[ground_area.id, ground_area]]),
    maximum_snap_distance: navigation_cell_size,
    maximum_visited: 2_048,
    allow_partial: false,
  } as const;
  const closed_path = find_navigation_path(
    closed_navigation.snapshot(),
    start,
    goal,
    query_options,
  );
  if (
    closed_path.type !== "unavailable" && closed_path.type !== "unreachable"
  ) {
    throw new Error(
      `adventure closed gate ${
        JSON.stringify(gate.id)
      } returned navigation path ${closed_path.type}`,
    );
  }
  const open_snapshot = open_navigation.snapshot();
  const open_path = find_navigation_path(
    open_snapshot,
    start,
    goal,
    query_options,
  );
  if (open_path.type !== "complete") {
    throw new Error(
      `adventure open gate ${
        JSON.stringify(gate.id)
      } returned navigation path ${open_path.type}`,
    );
  }

  const closed_move = character_route(start, goal, gate);
  const open_move = character_route(start, goal);
  if (
    closed_move.contacts.length === 0 ||
    closed_move.displacement.z >= goal.z - start.z
  ) {
    throw new Error(
      `adventure closed gate ${
        JSON.stringify(gate.id)
      } did not block the physics route`,
    );
  }
  if (
    open_move.contacts.length !== 0 ||
    Math.abs(open_move.pose.position.x - goal.x) > 1e-9 ||
    Math.abs(open_move.pose.position.z - goal.z) > 1e-9
  ) {
    throw new Error(
      `adventure open gate ${
        JSON.stringify(gate.id)
      } did not permit the physics route to (${goal.x}, ${goal.z})`,
    );
  }

  return Object.freeze({
    closed_gate: Object.freeze({
      type: "blocked",
      navigation_result: closed_path.type,
      stop_x_microunits: to_microunits(closed_move.pose.position.x),
      stop_z_microunits: to_microunits(closed_move.pose.position.z),
      physics_contacts: closed_move.contacts.length,
    }),
    open_gate: Object.freeze({
      type: "route",
      goal_x_microunits: to_microunits(goal.x),
      goal_z_microunits: to_microunits(goal.z),
      navigation_revision: open_snapshot.revision,
      path_points: open_path.path.points.length,
      path_cost_microunits: to_microunits(open_path.path.total_cost),
    }),
  });
}

function build_navigation(
  floor: AdventureBrush,
  profile: Extract<
    ReturnType<typeof create_agent_profile>,
    { readonly type: "ready" }
  >["profile"],
  obstacles: readonly NavigationObstacle[],
  gate_state: "closed" | "open",
): NavigationMesh {
  const floor_footprint = brush_footprint(floor);
  const width = floor_footprint.width / navigation_cell_size;
  const depth = floor_footprint.depth / navigation_cell_size;
  const tile_input = navigation_grid_tile_input({
    id: navigation_tile_id(`adventure-room-${gate_state}`),
    coordinate_x: 0,
    coordinate_z: 0,
    source_revision: 1,
    origin: vec3(
      floor.center_x2 / 2 - floor_footprint.width / 2,
      floor.elevation + floor.height,
      floor.center_z2 / 2 - floor_footprint.depth / 2,
    ),
    width,
    depth,
    cell_size: navigation_cell_size,
    cell_height: 0.1,
    default_area: ground_area.id,
    obstacles,
  });
  const tile_result = build_navigation_tile(tile_input, profile);
  if (tile_result.type !== "ready") {
    throw new Error(
      `adventure ${gate_state} navigation tile failed: ${
        tile_result.type === "malformed_geometry"
          ? tile_result.reason
          : "cancelled"
      }`,
    );
  }
  const navigation = new NavigationMesh({ profile });
  const published = navigation.publish(tile_result.tile);
  if (published.type === "failed") {
    throw new Error(
      `adventure ${gate_state} navigation mesh failed: ${published.reason}`,
    );
  }
  return navigation;
}

function character_route(
  start: ReturnType<typeof vec3>,
  goal: ReturnType<typeof vec3>,
  gate?: AdventureBrush,
) {
  const world = new PhysicsWorld({
    id: physics_world_id(
      gate === undefined ? "adventure-open-gate" : "adventure-closed-gate",
    ),
    fixed_step_seconds: 1 / 60,
    gravity: vec3(0, 0, 0),
  });
  const character_shape = created(
    world.create_shape(box_shape(vec3(0.275, 0.5, 0.275))),
    "adventure character shape",
  );
  if (gate !== undefined) {
    const footprint = brush_footprint(gate);
    const gate_shape = created(
      world.create_shape(
        box_shape(
          vec3(footprint.width / 2, gate.height / 2, footprint.depth / 2),
        ),
      ),
      `adventure gate ${JSON.stringify(gate.id)} shape`,
    );
    const gate_body = created(
      world.create_body({
        motion: "static",
        pose: rigid_pose(vec3(
          gate.center_x2 / 2,
          gate.elevation + gate.height / 2,
          gate.center_z2 / 2,
        )),
      }),
      `adventure gate ${JSON.stringify(gate.id)} body`,
    );
    created(
      world.create_collider({ body: gate_body, shape: gate_shape }),
      `adventure gate ${JSON.stringify(gate.id)} collider`,
    );
  }
  return world.move_character({
    shape: character_shape,
    pose: rigid_pose(vec3(start.x, start.y + 0.5, start.z)),
    displacement: vec3(goal.x - start.x, 0, goal.z - start.z),
    step_height: 0,
    maximum_slope_radians: Math.PI / 4,
    skin: 0.01,
  });
}

function created<Id>(
  result: PhysicsMutationResult<Id>,
  label: string,
): Id {
  if (result.type === "failed") {
    throw new Error(`${label} failed: ${result.reason}`);
  }
  return result.id;
}

function traversal_floor(
  document: AdventureDocument,
  gate: AdventureBrush,
): AdventureBrush {
  const player_x = document.layout.player_start.x2 / 2;
  const player_z = document.layout.player_start.z2 / 2;
  const gate_x = gate.center_x2 / 2;
  const gate_z = gate.center_z2 / 2;
  const floors = document.layout.brushes.filter((brush) => {
    if (brush.kind !== "block") return false;
    const footprint = brush_footprint(brush);
    const minimum_x = brush.center_x2 / 2 - footprint.width / 2;
    const maximum_x = brush.center_x2 / 2 + footprint.width / 2;
    const minimum_z = brush.center_z2 / 2 - footprint.depth / 2;
    const maximum_z = brush.center_z2 / 2 + footprint.depth / 2;
    return brush.elevation + brush.height <= gate.elevation &&
      player_x >= minimum_x && player_x <= maximum_x &&
      player_z >= minimum_z && player_z <= maximum_z &&
      gate_x >= minimum_x && gate_x <= maximum_x &&
      gate_z >= minimum_z && gate_z <= maximum_z;
  }).sort((left, right) =>
    right.width * right.depth - left.width * left.depth ||
    left.slot - right.slot
  );
  const floor = floors[0];
  if (floor === undefined) {
    throw new Error(
      `adventure layout ${
        JSON.stringify(document.layout.name)
      } has no floor spanning player start and gate ${JSON.stringify(gate.id)}`,
    );
  }
  return floor;
}

function bound_brush(
  document: AdventureDocument,
  interaction_id: string,
): AdventureBrush {
  const binding = document.layout.interaction_bindings.find(({ interaction }) =>
    interaction === interaction_id
  );
  if (binding === undefined) {
    throw new Error(
      `adventure project interaction ${interaction_id} has no brush binding`,
    );
  }
  const brush = document.layout.brushes.find(({ id }) => id === binding.brush);
  if (brush === undefined) {
    throw new Error(
      `adventure project interaction ${interaction_id} binds missing brush ${binding.brush}`,
    );
  }
  return brush;
}

function brush_obstacle(brush: AdventureBrush): NavigationObstacle {
  const footprint = brush_footprint(brush);
  return navigation_obstacle({
    id: navigation_obstacle_id(brush.id),
    revision: 1,
    minimum: vec3(
      brush.center_x2 / 2 - footprint.width / 2,
      brush.elevation,
      brush.center_z2 / 2 - footprint.depth / 2,
    ),
    maximum: vec3(
      brush.center_x2 / 2 + footprint.width / 2,
      brush.elevation + brush.height,
      brush.center_z2 / 2 + footprint.depth / 2,
    ),
  });
}

function brush_footprint(
  brush: AdventureBrush,
): { readonly width: number; readonly depth: number } {
  return Math.abs(brush.yaw_quarters) % 2 === 0
    ? { width: brush.width, depth: brush.depth }
    : { width: brush.depth, depth: brush.width };
}

function to_microunits(value: number): number {
  return Math.round(value * microunits_per_meter);
}
