import { editor_preset_id } from "@ink/authoring/identity.ts";
import {
  strategy_faction_id,
  strategy_objective_id,
  strategy_project_id,
  strategy_resource_id,
  strategy_route_id,
  strategy_structure_id,
  strategy_unit_id,
  strategy_wave_id,
} from "./identity.ts";
import {
  strategy_project,
  type StrategyObjectiveCondition,
  type StrategyPoint,
  type StrategyProject,
  type StrategyRoutePoints,
  type StrategyStructure,
} from "./model.ts";
import { strategy_presets } from "./presets.ts";
import { validate_strategy_project } from "./validation.ts";

export function parse_strategy_project(
  source: string,
  source_name = "strategy project",
): StrategyProject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`${source_name} is not valid JSON`, { cause });
  }
  const root = exact_record(parsed, [
    "factions",
    "id",
    "map",
    "name",
    "objectives",
    "preset_id",
    "resources",
    "routes",
    "schema_version",
    "structures",
    "waves",
  ], source_name);
  if (root.schema_version !== 1) {
    throw new Error(
      `${source_name} schema version ${
        JSON.stringify(root.schema_version)
      } is unsupported`,
    );
  }
  const map = exact_record(root.map, ["height", "width"], `${source_name} map`);
  const preset_id = editor_preset_id(
    text(root.preset_id, `${source_name} preset_id`),
  );
  if (!strategy_presets.some(({ id }) => id === preset_id)) {
    throw new Error(`${source_name} preset ${preset_id} is unavailable`);
  }
  const project = strategy_project({
    schema_version: 1,
    id: strategy_project_id(text(root.id, `${source_name} id`)),
    name: text(root.name, `${source_name} name`),
    preset_id,
    map: {
      width: finite_number(map.width, `${source_name} map width`),
      height: finite_number(map.height, `${source_name} map height`),
    },
    resources: array(root.resources, `${source_name} resources`).map(
      (resource, index) =>
        strategy_resource_id(text(resource, `resource ${index}`)),
    ),
    factions: array(root.factions, `${source_name} factions`).map(
      (entry, index) => {
        const faction = exact_record(
          entry,
          ["id", "name", "relation"],
          `${source_name} factions[${index}]`,
        );
        return {
          id: strategy_faction_id(text(faction.id, `faction ${index} id`)),
          name: text(faction.name, `faction ${index} name`),
          relation: one_of(
            faction.relation,
            ["player", "ally", "opponent", "neutral"],
            `faction ${index} relation`,
          ),
        };
      },
    ),
    structures: array(root.structures, `${source_name} structures`).map(
      (entry, index) => parse_structure(entry, index, source_name),
    ),
    routes: array(root.routes, `${source_name} routes`).map((entry, index) => {
      const route = exact_record(
        entry,
        ["id", "points"],
        `${source_name} routes[${index}]`,
      );
      const raw_points = array(route.points, `route ${index} points`);
      if (raw_points.length < 2) {
        throw new Error(
          `route ${index} points has ${raw_points.length} entries; at least two are required`,
        );
      }
      const points: StrategyRoutePoints = [
        parse_point(raw_points[0], `route ${index} points[0]`),
        parse_point(raw_points[1], `route ${index} points[1]`),
        ...raw_points.slice(2).map((point, point_index) =>
          parse_point(point, `route ${index} points[${point_index + 2}]`)
        ),
      ];
      return {
        id: strategy_route_id(text(route.id, `route ${index} id`)),
        points,
      };
    }),
    waves: array(root.waves, `${source_name} waves`).map((entry, index) => {
      const wave = exact_record(entry, [
        "count",
        "faction_id",
        "id",
        "route_id",
        "starts_at_seconds",
        "unit_id",
      ], `${source_name} waves[${index}]`);
      return {
        id: strategy_wave_id(text(wave.id, `wave ${index} id`)),
        route_id: strategy_route_id(
          text(wave.route_id, `wave ${index} route_id`),
        ),
        faction_id: strategy_faction_id(
          text(wave.faction_id, `wave ${index} faction_id`),
        ),
        unit_id: strategy_unit_id(
          text(wave.unit_id, `wave ${index} unit_id`),
        ),
        count: finite_number(wave.count, `wave ${index} count`),
        starts_at_seconds: finite_number(
          wave.starts_at_seconds,
          `wave ${index} starts_at_seconds`,
        ),
      };
    }),
    objectives: array(root.objectives, `${source_name} objectives`).map(
      (entry, index) => {
        const objective = exact_record(
          entry,
          ["condition", "id", "text"],
          `${source_name} objectives[${index}]`,
        );
        return {
          id: strategy_objective_id(
            text(objective.id, `objective ${index} id`),
          ),
          text: text(objective.text, `objective ${index} text`),
          condition: parse_objective_condition(
            objective.condition,
            `objective ${index} condition`,
          ),
        };
      },
    ),
  });
  const diagnostics = validate_strategy_project(project).filter(
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

export function serialize_strategy_project(project: StrategyProject): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

function parse_structure(
  value: unknown,
  index: number,
  source_name: string,
): StrategyStructure {
  const candidate = object_record(
    value,
    `${source_name} structures[${index}]`,
  );
  const kind = one_of(
    candidate.kind,
    ["headquarters", "defense", "objective", "barracks"],
    `structure ${index} kind`,
  );
  const fields = kind === "barracks"
    ? ["faction_id", "id", "kind", "position", "produces_unit_id"]
    : ["faction_id", "id", "kind", "position"];
  const structure = exact_record(
    value,
    fields,
    `${source_name} structures[${index}]`,
  );
  const common = {
    id: strategy_structure_id(text(structure.id, `structure ${index} id`)),
    faction_id: strategy_faction_id(
      text(structure.faction_id, `structure ${index} faction_id`),
    ),
    position: parse_point(
      structure.position,
      `structure ${index} position`,
    ),
  };
  if (kind === "barracks") {
    return {
      ...common,
      kind,
      produces_unit_id: strategy_unit_id(
        text(
          structure.produces_unit_id,
          `structure ${index} produces_unit_id`,
        ),
      ),
    };
  }
  return { ...common, kind };
}

function parse_objective_condition(
  value: unknown,
  label: string,
): StrategyObjectiveCondition {
  const candidate = object_record(value, label);
  const type = one_of(
    candidate.type,
    [
      "survive_waves",
      "destroy_structure",
      "capture_structure",
      "produce_units",
    ],
    `${label} type`,
  );
  if (type === "survive_waves") {
    exact_record(value, ["type"], label);
    return { type };
  }
  if (type === "produce_units") {
    const condition = exact_record(
      value,
      ["count", "type", "unit_id"],
      label,
    );
    return {
      type,
      unit_id: strategy_unit_id(text(condition.unit_id, `${label} unit_id`)),
      count: finite_number(condition.count, `${label} count`),
    };
  }
  const condition = exact_record(value, ["structure_id", "type"], label);
  return {
    type,
    structure_id: strategy_structure_id(
      text(condition.structure_id, `${label} structure_id`),
    ),
  };
}

function parse_point(value: unknown, label: string): StrategyPoint {
  const point = exact_record(value, ["x", "y"], label);
  return {
    x: finite_number(point.x, `${label} x`),
    y: finite_number(point.y, `${label} y`),
  };
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
