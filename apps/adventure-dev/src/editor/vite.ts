import { rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import {
  parse_adventure_document,
  serialize_adventure_document,
} from "@ink/adventure-editor/document.ts";
import { adventure_project_save_url } from "./level.ts";

const maximum_project_bytes = 2 * 1024 * 1024;

export function adventure_project_document(project_file: URL): Plugin {
  if (project_file.protocol !== "file:") {
    throw new Error(
      `adventure project file ${
        JSON.stringify(project_file.href)
      } must be local`,
    );
  }
  let save_queue = Promise.resolve();
  return {
    name: "ink-adventure-project-document",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = new URL(request.url ?? "/", "http://ink.local").pathname;
        if (path !== adventure_project_save_url) {
          next();
          return;
        }
        if (request.method !== "PUT") {
          response.statusCode = 405;
          response.setHeader("allow", "PUT");
          response.end("adventure projects are saved with PUT");
          return;
        }
        try {
          const source = await read_request_source(request);
          const pending_save = save_queue.then(() =>
            write_adventure_project(project_file, source)
          );
          save_queue = pending_save.catch(() => {});
          await pending_save;
          response.statusCode = 204;
          response.end();
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          response.statusCode = error instanceof ProjectRequestError
            ? 400
            : 500;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(message);
        }
      });
    },
  };
}

export async function write_adventure_project(
  project_file: URL,
  source: string,
): Promise<void> {
  const project = parse_adventure_document(source);
  const path = fileURLToPath(project_file);
  const pending_path = `${path}.${process.pid}.pending`;
  try {
    await writeFile(
      pending_path,
      serialize_adventure_document(project),
      "utf8",
    );
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
    if (received > maximum_project_bytes) {
      throw new ProjectRequestError(
        `adventure project exceeds ${maximum_project_bytes} bytes`,
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
    throw new ProjectRequestError("adventure project must be UTF-8", {
      cause,
    });
  }
}

class ProjectRequestError extends Error {}
