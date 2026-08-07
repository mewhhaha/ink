import { rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import {
  level_save_url,
  parse_platformer_level,
  serialize_platformer_level,
} from "./level.ts";

const maximum_level_bytes = 2 * 1024 * 1024;

export function platformer_level_document(level_file: URL): Plugin {
  if (level_file.protocol !== "file:") {
    throw new Error(
      `platformer level file ${JSON.stringify(level_file.href)} must be local`,
    );
  }
  let save_queue = Promise.resolve();
  return {
    name: "ink-platformer-level-document",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = new URL(request.url ?? "/", "http://ink.local").pathname;
        if (path !== level_save_url) {
          next();
          return;
        }
        if (request.method !== "PUT") {
          response.statusCode = 405;
          response.setHeader("allow", "PUT");
          response.end("platformer levels are saved with PUT");
          return;
        }
        try {
          const source = await read_request_source(request);
          const pending_save = save_queue.then(() =>
            write_platformer_level(level_file, source)
          );
          save_queue = pending_save.catch(() => {});
          await pending_save;
          response.statusCode = 204;
          response.end();
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          response.statusCode = error instanceof LevelRequestError ? 400 : 500;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(message);
        }
      });
    },
  };
}

export async function write_platformer_level(
  level_file: URL,
  source: string,
): Promise<void> {
  const level = parse_platformer_level(source);
  const path = fileURLToPath(level_file);
  const pending_path = `${path}.${process.pid}.pending`;
  try {
    await writeFile(pending_path, serialize_platformer_level(level), "utf8");
    await rename(pending_path, path);
  } finally {
    await rm(pending_path, { force: true });
  }
}

async function read_request_source(request: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string"
      ? new TextEncoder().encode(chunk)
      : chunk;
    received += bytes.byteLength;
    if (received > maximum_level_bytes) {
      throw new LevelRequestError(
        `platformer level exceeds ${maximum_level_bytes} bytes`,
      );
    }
    chunks.push(bytes);
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (cause) {
    throw new LevelRequestError("platformer level must be UTF-8", { cause });
  }
}

class LevelRequestError extends Error {}
