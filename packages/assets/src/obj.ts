export type ObjVector3 = readonly [number, number, number];
export type ObjTextureCoordinate = readonly [number, number, number];

export interface ObjVertexReference {
  readonly position: number;
  readonly texture_coordinate?: number;
  readonly normal?: number;
}

export interface ObjTriangle {
  readonly vertices: readonly [
    ObjVertexReference,
    ObjVertexReference,
    ObjVertexReference,
  ];
  readonly object?: string;
  readonly group?: string;
  readonly material?: string;
}

export interface ObjDocument {
  readonly positions: readonly ObjVector3[];
  readonly texture_coordinates: readonly ObjTextureCoordinate[];
  readonly normals: readonly ObjVector3[];
  readonly triangles: readonly ObjTriangle[];
  readonly material_libraries: readonly string[];
}

export interface ObjParseFailure {
  readonly type: "invalid_obj";
  readonly source: string;
  readonly line: number;
  readonly reason: string;
}

export type ObjParseResult =
  | { readonly type: "ready"; readonly document: ObjDocument }
  | ObjParseFailure;

export function parse_obj(source_text: string, source: string): ObjParseResult {
  const positions: ObjVector3[] = [];
  const texture_coordinates: ObjTextureCoordinate[] = [];
  const normals: ObjVector3[] = [];
  const triangles: ObjTriangle[] = [];
  const material_libraries: string[] = [];
  let object: string | undefined;
  let group: string | undefined;
  let material: string | undefined;

  for (const [line_index, untrimmed] of source_text.split(/\r?\n/).entries()) {
    const line_number = line_index + 1;
    const line = untrimmed.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const comment_start = line.indexOf("#");
    const fields = (comment_start < 0 ? line : line.slice(0, comment_start))
      .trim().split(/\s+/);
    const directive = fields[0];
    const values = fields.slice(1);

    if (directive === "v") {
      const parsed = parse_vector(values, 3, source, line_number, "position");
      if (parsed.type === "invalid_obj") return parsed;
      positions.push(parsed.value);
      continue;
    }
    if (directive === "vt") {
      const parsed = parse_texture_coordinate(values, source, line_number);
      if (parsed.type === "invalid_obj") return parsed;
      texture_coordinates.push(parsed.value);
      continue;
    }
    if (directive === "vn") {
      const parsed = parse_vector(values, 3, source, line_number, "normal");
      if (parsed.type === "invalid_obj") return parsed;
      normals.push(parsed.value);
      continue;
    }
    if (directive === "o") {
      object = joined_name(values);
      continue;
    }
    if (directive === "g") {
      group = joined_name(values);
      continue;
    }
    if (directive === "usemtl") {
      material = joined_name(values);
      continue;
    }
    if (directive === "mtllib") {
      const library = joined_name(values);
      if (library !== undefined) material_libraries.push(library);
      continue;
    }
    if (directive !== "f") continue;
    if (values.length < 3) {
      return failure(
        source,
        line_number,
        `face has ${values.length} vertices; expected at least 3`,
      );
    }

    const polygon: ObjVertexReference[] = [];
    for (const vertex of values) {
      const parsed = parse_vertex_reference(
        vertex,
        positions.length,
        texture_coordinates.length,
        normals.length,
        source,
        line_number,
      );
      if (parsed.type === "invalid_obj") return parsed;
      polygon.push(parsed.value);
    }
    for (let index = 1; index < polygon.length - 1; index += 1) {
      triangles.push({
        vertices: [polygon[0], polygon[index], polygon[index + 1]],
        ...(object === undefined ? {} : { object }),
        ...(group === undefined ? {} : { group }),
        ...(material === undefined ? {} : { material }),
      });
    }
  }

  return {
    type: "ready",
    document: {
      positions,
      texture_coordinates,
      normals,
      triangles,
      material_libraries,
    },
  };
}

type Parsed<T> =
  | { readonly type: "parsed"; readonly value: T }
  | ObjParseFailure;

function parse_vector(
  fields: readonly string[],
  count: number,
  source: string,
  line: number,
  label: string,
): Parsed<ObjVector3> {
  if (fields.length < count) {
    return failure(source, line, `${label} needs ${count} coordinates`);
  }
  const coordinates = fields.slice(0, count).map(Number);
  if (coordinates.some((coordinate) => !Number.isFinite(coordinate))) {
    return failure(
      source,
      line,
      `${label} has non-finite coordinates ${
        JSON.stringify(fields.slice(0, count))
      }`,
    );
  }
  return {
    type: "parsed",
    value: [coordinates[0], coordinates[1], coordinates[2]],
  };
}

function parse_texture_coordinate(
  fields: readonly string[],
  source: string,
  line: number,
): Parsed<ObjTextureCoordinate> {
  if (fields.length === 0 || fields.length > 3) {
    return failure(
      source,
      line,
      `texture coordinate has ${fields.length} values; expected 1..3`,
    );
  }
  const coordinates = fields.map(Number);
  if (coordinates.some((coordinate) => !Number.isFinite(coordinate))) {
    return failure(
      source,
      line,
      `texture coordinate has non-finite coordinates ${JSON.stringify(fields)}`,
    );
  }
  return {
    type: "parsed",
    value: [coordinates[0], coordinates[1] ?? 0, coordinates[2] ?? 0],
  };
}

function parse_vertex_reference(
  field: string,
  position_count: number,
  texture_coordinate_count: number,
  normal_count: number,
  source: string,
  line: number,
): Parsed<ObjVertexReference> {
  const indices = field.split("/");
  if (indices.length > 3 || indices[0].length === 0) {
    return failure(
      source,
      line,
      `face vertex ${JSON.stringify(field)} is malformed`,
    );
  }
  const position = resolve_index(
    indices[0],
    position_count,
    "position",
    source,
    line,
  );
  if (position.type === "invalid_obj") return position;
  const texture_coordinate = indices[1]
    ? resolve_index(
      indices[1],
      texture_coordinate_count,
      "texture coordinate",
      source,
      line,
    )
    : undefined;
  if (texture_coordinate?.type === "invalid_obj") return texture_coordinate;
  const normal = indices[2]
    ? resolve_index(indices[2], normal_count, "normal", source, line)
    : undefined;
  if (normal?.type === "invalid_obj") return normal;
  return {
    type: "parsed",
    value: {
      position: position.value,
      ...(texture_coordinate === undefined
        ? {}
        : { texture_coordinate: texture_coordinate.value }),
      ...(normal === undefined ? {} : { normal: normal.value }),
    },
  };
}

function resolve_index(
  field: string,
  count: number,
  label: string,
  source: string,
  line: number,
): Parsed<number> {
  const parsed = Number(field);
  const index = parsed > 0 ? parsed - 1 : count + parsed;
  if (
    !Number.isInteger(parsed) || parsed === 0 || index < 0 || index >= count
  ) {
    return failure(
      source,
      line,
      `${label} index ${
        JSON.stringify(field)
      } is outside the available ${count} values`,
    );
  }
  return { type: "parsed", value: index };
}

function joined_name(fields: readonly string[]): string | undefined {
  const name = fields.join(" ").trim();
  return name.length === 0 ? undefined : name;
}

function failure(
  source: string,
  line: number,
  reason: string,
): ObjParseFailure {
  return { type: "invalid_obj", source, line, reason };
}
