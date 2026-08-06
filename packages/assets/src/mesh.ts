import { type ObjDocument, type ObjVector3, parse_obj } from "./obj.ts";

export interface ModelMesh {
  readonly vertices: Float32Array;
  readonly vertex_count: number;
}

export function parse_obj_model(
  source_text: string,
  source = "model.obj",
): ModelMesh {
  const parsed = parse_obj(source_text, source);
  if (parsed.type === "invalid_obj") {
    throw new Error(
      `OBJ ${
        JSON.stringify(parsed.source)
      } line ${parsed.line}: ${parsed.reason}`,
    );
  }
  return pack_obj_mesh(parsed.document, source);
}

export function pack_obj_mesh(
  document: ObjDocument,
  source = "OBJ document",
): ModelMesh {
  if (document.triangles.length === 0) {
    throw new Error(`${source} contains no faces`);
  }
  const vertices = new Float32Array(document.triangles.length * 18);
  let offset = 0;
  for (const [triangle_index, triangle] of document.triangles.entries()) {
    const positions = triangle.vertices.map((vertex) =>
      document.positions[vertex.position]
    );
    if (positions.some((position) => position === undefined)) {
      throw new Error(
        `${source} triangle ${triangle_index} references a missing position`,
      );
    }
    const fallback = triangle_normal(
      positions[0],
      positions[1],
      positions[2],
      source,
      triangle_index,
    );
    for (const vertex of triangle.vertices) {
      const position = document.positions[vertex.position];
      const normal = vertex.normal === undefined
        ? fallback
        : document.normals[vertex.normal];
      if (normal === undefined) {
        throw new Error(
          `${source} triangle ${triangle_index} references missing normal ${vertex.normal}`,
        );
      }
      vertices.set(
        [...position, ...normalize(normal, source, triangle_index)],
        offset,
      );
      offset += 6;
    }
  }
  return { vertices, vertex_count: vertices.length / 6 };
}

function triangle_normal(
  first: ObjVector3,
  second: ObjVector3,
  third: ObjVector3,
  source: string,
  triangle: number,
): ObjVector3 {
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
  return normalize(
    [
      left[1] * right[2] - left[2] * right[1],
      left[2] * right[0] - left[0] * right[2],
      left[0] * right[1] - left[1] * right[0],
    ],
    source,
    triangle,
  );
}

function normalize(
  vector: ObjVector3,
  source: string,
  triangle: number,
): ObjVector3 {
  const length = Math.hypot(...vector);
  if (length === 0) {
    throw new Error(`${source} triangle ${triangle} has a zero-length normal`);
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
