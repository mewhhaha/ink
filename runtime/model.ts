export interface ModelMesh {
  readonly vertices: Float32Array;
  readonly vertex_count: number;
}

interface FaceVertex {
  readonly position: readonly [number, number, number];
  readonly normal: readonly [number, number, number] | undefined;
}

export function parse_obj_model(source: string): ModelMesh {
  const positions: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const vertices: number[] = [];

  for (const [line_index, source_line] of source.split(/\r?\n/).entries()) {
    const line = source_line.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const [kind, ...parts] = line.split(/\s+/);
    if (kind === "v") {
      positions.push(parse_vector(parts, line_index + 1, "position"));
      continue;
    }
    if (kind === "vn") {
      normals.push(normalize(parse_vector(parts, line_index + 1, "normal")));
      continue;
    }
    if (kind !== "f") continue;
    if (parts.length < 3) {
      throw new Error(
        `OBJ line ${line_index + 1} face has ${parts.length} vertices`,
      );
    }

    const face = parts.map((part) =>
      parse_face_vertex(part, positions, normals, line_index + 1)
    );
    for (let index = 1; index < face.length - 1; index += 1) {
      append_triangle(vertices, face[0], face[index], face[index + 1]);
    }
  }

  if (vertices.length === 0) throw new Error("OBJ model contains no faces");
  return {
    vertices: new Float32Array(vertices),
    vertex_count: vertices.length / 6,
  };
}

function parse_vector(
  parts: readonly string[],
  line: number,
  kind: string,
): [number, number, number] {
  if (parts.length < 3) {
    throw new Error(`OBJ line ${line} ${kind} needs three coordinates`);
  }
  const vector = parts.slice(0, 3).map(Number);
  if (vector.some((coordinate) => !Number.isFinite(coordinate))) {
    throw new Error(
      `OBJ line ${line} ${kind} has non-numeric coordinates ${
        JSON.stringify(parts)
      }`,
    );
  }
  return [vector[0], vector[1], vector[2]];
}

function parse_face_vertex(
  source: string,
  positions: readonly (readonly [number, number, number])[],
  normals: readonly (readonly [number, number, number])[],
  line: number,
): FaceVertex {
  const fields = source.split("/");
  const position =
    positions[resolve_obj_index(fields[0], positions.length, line, "position")];
  const normal = fields[2]
    ? normals[resolve_obj_index(fields[2], normals.length, line, "normal")]
    : undefined;
  return { position, normal };
}

function resolve_obj_index(
  source: string,
  count: number,
  line: number,
  kind: string,
): number {
  const parsed = Number(source);
  const index = parsed > 0 ? parsed - 1 : count + parsed;
  if (
    !Number.isInteger(parsed) || parsed === 0 || index < 0 || index >= count
  ) {
    throw new Error(
      `OBJ line ${line} ${kind} index ${
        JSON.stringify(source)
      } is outside 1..${count}`,
    );
  }
  return index;
}

function append_triangle(
  output: number[],
  first: FaceVertex,
  second: FaceVertex,
  third: FaceVertex,
): void {
  const fallback = triangle_normal(
    first.position,
    second.position,
    third.position,
  );
  for (const vertex of [first, second, third]) {
    output.push(...vertex.position, ...(vertex.normal ?? fallback));
  }
}

function triangle_normal(
  first: readonly [number, number, number],
  second: readonly [number, number, number],
  third: readonly [number, number, number],
): [number, number, number] {
  const left = [
    second[0] - first[0],
    second[1] - first[1],
    second[2] - first[2],
  ] as const;
  const right = [
    third[0] - first[0],
    third[1] - first[1],
    third[2] - first[2],
  ] as const;
  return normalize([
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ]);
}

function normalize(
  vector: readonly [number, number, number],
): [number, number, number] {
  const length = Math.hypot(...vector);
  if (length === 0) {
    throw new Error(`OBJ normal ${JSON.stringify(vector)} has zero length`);
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
