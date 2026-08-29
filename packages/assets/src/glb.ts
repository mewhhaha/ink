export interface GlbContainer {
  readonly binary_chunk?: Uint8Array;
  readonly json_source: string;
}

export interface GlbContainerFailure {
  readonly type: "invalid_gltf";
  readonly source: string;
  readonly field: string;
  readonly offset?: number;
  readonly reason: string;
}

export type GlbContainerResult =
  | { readonly type: "ready"; readonly container: GlbContainer }
  | GlbContainerFailure;

const glb_magic = 0x46546c67;
const json_chunk_type = 0x4e4f534a;
const binary_chunk_type = 0x004e4942;

export function decode_glb_container(
  bytes: Uint8Array,
  source: string,
): GlbContainerResult {
  if (bytes.length < 12) {
    return failure(
      source,
      "$",
      `GLB has ${bytes.length} bytes; header needs 12`,
      0,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== glb_magic) {
    return failure(source, "$", "GLB magic is not 0x46546c67", 0);
  }
  const version = view.getUint32(4, true);
  if (version !== 2) {
    return failure(
      source,
      "$.asset.version",
      `GLB version ${version} is not supported`,
      4,
    );
  }
  const declared_length = view.getUint32(8, true);
  if (declared_length !== bytes.length) {
    return failure(
      source,
      "$",
      `GLB declares ${declared_length} bytes but contains ${bytes.length}`,
      8,
    );
  }

  let offset = 12;
  let chunk_index = 0;
  let json_bytes: Uint8Array | undefined;
  let binary_chunk: Uint8Array | undefined;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      return failure(source, "$", "GLB chunk header is truncated", offset);
    }
    const chunk_length = view.getUint32(offset, true);
    const chunk_type = view.getUint32(offset + 4, true);
    if (chunk_length % 4 !== 0) {
      return failure(
        source,
        "$",
        `GLB chunk at offset ${offset} has unaligned length ${chunk_length}`,
        offset,
      );
    }
    if (chunk_index === 0 && chunk_type !== json_chunk_type) {
      return failure(source, "$", "GLB first chunk must contain JSON", offset);
    }
    const content_start = offset + 8;
    const content_end = content_start + chunk_length;
    if (content_end > bytes.length) {
      return failure(
        source,
        "$",
        `GLB chunk at offset ${offset} ends at ${content_end}, beyond ${bytes.length}`,
        offset,
      );
    }
    const content = bytes.slice(content_start, content_end);
    if (chunk_type === json_chunk_type) {
      if (json_bytes !== undefined) {
        return failure(
          source,
          "$",
          "GLB contains more than one JSON chunk",
          offset,
        );
      }
      json_bytes = content;
    } else if (chunk_type === binary_chunk_type) {
      if (binary_chunk !== undefined) {
        return failure(
          source,
          "$",
          "GLB contains more than one binary chunk",
          offset,
        );
      }
      binary_chunk = content;
    }
    offset = content_end;
    chunk_index += 1;
  }
  if (json_bytes === undefined) {
    return failure(source, "$", "GLB does not contain a JSON chunk", 12);
  }

  let json_source: string;
  try {
    json_source = new TextDecoder("utf-8", { fatal: true }).decode(json_bytes);
    while (json_source.endsWith("\0") || json_source.endsWith(" ")) {
      json_source = json_source.slice(0, -1);
    }
  } catch (error) {
    return failure(
      source,
      "$",
      `GLB JSON chunk is not UTF-8: ${
        error instanceof Error ? error.message : String(error)
      }`,
      20,
    );
  }
  return {
    type: "ready",
    container: {
      json_source,
      ...(binary_chunk === undefined ? {} : { binary_chunk }),
    },
  };
}

function failure(
  source: string,
  field: string,
  reason: string,
  offset?: number,
): GlbContainerFailure {
  return {
    type: "invalid_gltf",
    source,
    field,
    reason,
    ...(offset === undefined ? {} : { offset }),
  };
}
