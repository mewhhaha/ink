import { editor_preset_id } from "@ink/authoring/identity.ts";
import {
  vehicle_archetype_id,
  vehicle_checkpoint_id,
  vehicle_hazard_id,
  vehicle_project_id,
  vehicle_target_id,
  vehicle_waypoint_id,
} from "./identity.ts";
import {
  vehicle_project,
  type VehicleObjective,
  type VehicleProject,
} from "./model.ts";
import { vehicle_presets } from "./catalog.ts";
import { validate_vehicle_project } from "./validation.ts";

export function parse_vehicle_project(
  source: string,
  source_name = "vehicle project",
): VehicleProject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`${source_name} is not valid JSON`, { cause });
  }
  const root = exact_record(parsed, [
    "checkpoints",
    "hazards",
    "id",
    "name",
    "objective",
    "player_vehicle_id",
    "preset_id",
    "schema_version",
    "waypoints",
  ], source_name);
  if (root.schema_version !== 1) {
    throw new Error(
      `${source_name} schema version ${
        JSON.stringify(root.schema_version)
      } is unsupported`,
    );
  }
  const preset_id = editor_preset_id(
    text(root.preset_id, `${source_name} preset_id`),
  );
  if (!vehicle_presets.some(({ id }) => id === preset_id)) {
    throw new Error(`${source_name} preset ${preset_id} is unavailable`);
  }
  const project = vehicle_project({
    schema_version: 1,
    id: vehicle_project_id(text(root.id, `${source_name} id`)),
    name: text(root.name, `${source_name} name`),
    preset_id,
    player_vehicle_id: vehicle_archetype_id(
      text(root.player_vehicle_id, `${source_name} player_vehicle_id`),
    ),
    waypoints: array(root.waypoints, `${source_name} waypoints`).map(
      (entry, index) => {
        const waypoint = exact_record(
          entry,
          ["id", "position", "speed_limit"],
          `${source_name} waypoints[${index}]`,
        );
        const position = exact_record(
          waypoint.position,
          ["x", "y", "z"],
          `waypoint ${index} position`,
        );
        return {
          id: vehicle_waypoint_id(text(waypoint.id, `waypoint ${index} id`)),
          position: {
            x: finite_number(position.x, `waypoint ${index} position x`),
            y: finite_number(position.y, `waypoint ${index} position y`),
            z: finite_number(position.z, `waypoint ${index} position z`),
          },
          speed_limit: finite_number(
            waypoint.speed_limit,
            `waypoint ${index} speed_limit`,
          ),
        };
      },
    ),
    checkpoints: array(root.checkpoints, `${source_name} checkpoints`).map(
      (entry, index) => {
        const checkpoint = exact_record(
          entry,
          ["id", "waypoint_id"],
          `${source_name} checkpoints[${index}]`,
        );
        return {
          id: vehicle_checkpoint_id(
            text(checkpoint.id, `checkpoint ${index} id`),
          ),
          waypoint_id: vehicle_waypoint_id(
            text(checkpoint.waypoint_id, `checkpoint ${index} waypoint_id`),
          ),
        };
      },
    ),
    hazards: array(root.hazards, `${source_name} hazards`).map(
      (entry, index) => {
        const hazard = exact_record(
          entry,
          ["id", "kind", "waypoint_id"],
          `${source_name} hazards[${index}]`,
        );
        return {
          id: vehicle_hazard_id(text(hazard.id, `hazard ${index} id`)),
          waypoint_id: vehicle_waypoint_id(
            text(hazard.waypoint_id, `hazard ${index} waypoint_id`),
          ),
          kind: one_of(
            hazard.kind,
            ["obstacle", "weather", "enemy", "depth"],
            `hazard ${index} kind`,
          ),
        };
      },
    ),
    objective: parse_objective(root.objective, `${source_name} objective`),
  });
  const diagnostics = validate_vehicle_project(project).filter(
    ({ severity }) => severity === "error",
  );
  if (diagnostics.length > 0) {
    throw new Error(
      `${source_name} is invalid: ${
        diagnostics.map(({ message }) => message).join("; ")
      }`,
    );
  }
  return project;
}

export function serialize_vehicle_project(project: VehicleProject): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

function parse_objective(value: unknown, label: string): VehicleObjective {
  const candidate = object_record(value, label);
  const type = one_of(
    candidate.type,
    ["finish", "survive", "escort", "destroy_target"],
    `${label} type`,
  );
  switch (type) {
    case "finish": {
      const objective = exact_record(value, ["laps", "type"], label);
      return {
        type,
        laps: finite_number(objective.laps, `${label} laps`),
      };
    }
    case "survive": {
      const objective = exact_record(
        value,
        ["duration_seconds", "type"],
        label,
      );
      return {
        type,
        duration_seconds: finite_number(
          objective.duration_seconds,
          `${label} duration_seconds`,
        ),
      };
    }
    case "escort": {
      const objective = exact_record(
        value,
        ["target_vehicle_id", "type"],
        label,
      );
      return {
        type,
        target_vehicle_id: vehicle_archetype_id(
          text(objective.target_vehicle_id, `${label} target_vehicle_id`),
        ),
      };
    }
    case "destroy_target": {
      const objective = exact_record(value, ["target_id", "type"], label);
      return {
        type,
        target_id: vehicle_target_id(
          text(objective.target_id, `${label} target_id`),
        ),
      };
    }
  }
  const exhaustive: never = type;
  return exhaustive;
}

function exact_record(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = object_record(value, label);
  const expected = new Set(fields);
  const missing = fields.filter((field) => !(field in record));
  const unknown = Object.keys(record).filter((field) => !expected.has(field));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} fields differ; missing [${missing.join(", ")}], unknown [${
        unknown.join(", ")
      }]`,
    );
  }
  return record;
}

function object_record(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function finite_number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} must be finite`);
  }
  return value;
}

function one_of<const Value extends string>(
  value: unknown,
  choices: readonly Value[],
  label: string,
): Value {
  if (typeof value === "string") {
    const match = choices.find((choice) => choice === value);
    if (match !== undefined) return match;
  }
  throw new Error(
    `${label} ${JSON.stringify(value)} must be one of ${choices.join(", ")}`,
  );
}
