import type {
  PlatformerConnectionId,
  PlatformerLayerId,
  PlatformerLevelId,
  PlatformerRecordId,
} from "./identity.ts";
import {
  platformer_project,
  type PlatformerBounds,
  type PlatformerLogicConnection,
  type PlatformerPoint,
  type PlatformerProject,
  type PlatformerRecord,
} from "./model.ts";

export interface PlatformerRecordLocation {
  readonly level_id: PlatformerLevelId;
  readonly layer_id: PlatformerLayerId;
}

export function place_platformer_record(
  project: PlatformerProject,
  location: PlatformerRecordLocation,
  record: PlatformerRecord,
): PlatformerProject {
  const level = required_level(project, location.level_id);
  required_layer(level.layers, location.layer_id, location.level_id);
  const existing = level.layers.flatMap(({ records }) => records).find((
    { id },
  ) => id === record.id);
  if (existing !== undefined) {
    throw new Error(
      `level ${location.level_id} already contains record ${record.id}`,
    );
  }
  return platformer_project({
    ...project,
    levels: project.levels.map((candidate) =>
      candidate.id !== location.level_id ? candidate : {
        ...candidate,
        layers: candidate.layers.map((layer) =>
          layer.id !== location.layer_id
            ? layer
            : { ...layer, records: [...layer.records, record] }
        ),
      }
    ),
  });
}

export function move_platformer_record(
  project: PlatformerProject,
  level_id: PlatformerLevelId,
  record_id: PlatformerRecordId,
  displacement: PlatformerPoint,
): PlatformerProject {
  const level = required_level(project, level_id);
  const located = level.layers.some(({ records }) =>
    records.some(({ id }) => id === record_id)
  );
  if (!located) {
    throw new Error(`level ${level_id} does not contain record ${record_id}`);
  }
  if (!Number.isFinite(displacement.x) || !Number.isFinite(displacement.y)) {
    throw new Error(
      `record ${record_id} displacement (${String(displacement.x)}, ${
        String(displacement.y)
      }) must be finite`,
    );
  }
  return platformer_project({
    ...project,
    levels: project.levels.map((candidate) =>
      candidate.id !== level_id ? candidate : {
        ...candidate,
        layers: candidate.layers.map((layer) => ({
          ...layer,
          records: layer.records.map((record) =>
            record.id === record_id
              ? shift_record(record, displacement)
              : record
          ),
        })),
      }
    ),
  });
}

export function remove_platformer_record(
  project: PlatformerProject,
  level_id: PlatformerLevelId,
  record_id: PlatformerRecordId,
): PlatformerProject {
  const level = required_level(project, level_id);
  const located = level.layers.some(({ records }) =>
    records.some(({ id }) => id === record_id)
  );
  if (!located) {
    throw new Error(`level ${level_id} does not contain record ${record_id}`);
  }
  return platformer_project({
    ...project,
    levels: project.levels.map((candidate) =>
      candidate.id !== level_id ? candidate : {
        ...candidate,
        layers: candidate.layers.map((layer) => ({
          ...layer,
          records: layer.records.filter(({ id }) => id !== record_id),
        })),
      }
    ),
  });
}

export function connect_platformer_logic(
  project: PlatformerProject,
  level_id: PlatformerLevelId,
  connection: PlatformerLogicConnection,
): PlatformerProject {
  const level = required_level(project, level_id);
  if (level.connections.some(({ id }) => id === connection.id)) {
    throw new Error(
      `level ${level_id} already contains connection ${connection.id}`,
    );
  }
  return platformer_project({
    ...project,
    levels: project.levels.map((candidate) =>
      candidate.id === level_id
        ? { ...candidate, connections: [...candidate.connections, connection] }
        : candidate
    ),
  });
}

export function remove_platformer_connection(
  project: PlatformerProject,
  level_id: PlatformerLevelId,
  connection_id: PlatformerConnectionId,
): PlatformerProject {
  const level = required_level(project, level_id);
  if (!level.connections.some(({ id }) => id === connection_id)) {
    throw new Error(
      `level ${level_id} does not contain connection ${connection_id}`,
    );
  }
  return platformer_project({
    ...project,
    levels: project.levels.map((candidate) =>
      candidate.id === level_id
        ? {
          ...candidate,
          connections: candidate.connections.filter(({ id }) =>
            id !== connection_id
          ),
        }
        : candidate
    ),
  });
}

function shift_record(
  record: PlatformerRecord,
  displacement: PlatformerPoint,
): PlatformerRecord {
  switch (record.kind) {
    case "platform":
    case "hazard":
    case "trigger_zone":
    case "camera_zone":
    case "exit":
      return { ...record, bounds: shift_bounds(record.bounds, displacement) };
    case "checkpoint":
      return {
        ...record,
        bounds: shift_bounds(record.bounds, displacement),
        respawn_position: shift_point(record.respawn_position, displacement),
      };
    case "slope":
      return {
        ...record,
        start: shift_point(record.start, displacement),
        end: shift_point(record.end, displacement),
      };
    case "spawn":
    case "collectible":
      return {
        ...record,
        position: shift_point(record.position, displacement),
      };
    case "enemy":
      return {
        ...record,
        position: shift_point(record.position, displacement),
        ...(record.patrol_bounds === undefined ? {} : {
          patrol_bounds: shift_bounds(record.patrol_bounds, displacement),
        }),
      };
    case "moving_path":
      return {
        ...record,
        points: record.points.map((point) => shift_point(point, displacement)),
      };
  }
}

function shift_bounds(
  bounds: PlatformerBounds,
  displacement: PlatformerPoint,
): PlatformerBounds {
  return {
    minimum: shift_point(bounds.minimum, displacement),
    maximum: shift_point(bounds.maximum, displacement),
  };
}

function shift_point(
  point: PlatformerPoint,
  displacement: PlatformerPoint,
): PlatformerPoint {
  return { x: point.x + displacement.x, y: point.y + displacement.y };
}

function required_level(
  project: PlatformerProject,
  level_id: PlatformerLevelId,
) {
  const level = project.levels.find(({ id }) => id === level_id);
  if (level === undefined) {
    throw new Error(
      `platformer project ${project.id} does not contain level ${level_id}`,
    );
  }
  return level;
}

function required_layer(
  layers: PlatformerProject["levels"][number]["layers"],
  layer_id: PlatformerLayerId,
  level_id: PlatformerLevelId,
): void {
  if (!layers.some(({ id }) => id === layer_id)) {
    throw new Error(`level ${level_id} does not contain layer ${layer_id}`);
  }
}
