import type { GameArtifact } from "./artifact.ts";
import type { RuntimeGuest } from "./session.ts";

export interface WasmGuestAdapter<input, observation> {
  create(
    instance: WebAssembly.Instance,
    artifact: GameArtifact,
  ):
    | RuntimeGuest<input, observation>
    | Promise<RuntimeGuest<input, observation>>;
}

export async function instantiate_wasm_guest<input, observation>(
  artifact: GameArtifact,
  imports: WebAssembly.Imports,
  adapter: WasmGuestAdapter<input, observation>,
): Promise<RuntimeGuest<input, observation>> {
  let instance: WebAssembly.Instance;
  try {
    const module = await WebAssembly.compile(Uint8Array.from(artifact.wasm));
    instance = await WebAssembly.instantiate(module, imports);
  } catch (cause) {
    throw new Error(
      `guest ${JSON.stringify(artifact.guest_id)} artifact ${
        JSON.stringify(artifact.artifact_digest)
      } failed WebAssembly instantiation`,
      { cause },
    );
  }
  try {
    const guest = await adapter.create(instance, artifact);
    if (
      guest.artifact.guest_id !== artifact.guest_id ||
      guest.artifact.artifact_digest !== artifact.artifact_digest ||
      guest.artifact.schema_digest !== artifact.schema_digest
    ) {
      const mismatch = new Error(
        `Wasm adapter returned guest ${
          JSON.stringify(guest.artifact.guest_id)
        } artifact ${JSON.stringify(guest.artifact.artifact_digest)} schema ${
          JSON.stringify(guest.artifact.schema_digest)
        } for loaded guest ${JSON.stringify(artifact.guest_id)} artifact ${
          JSON.stringify(artifact.artifact_digest)
        } schema ${JSON.stringify(artifact.schema_digest)}`,
      );
      try {
        await guest.close();
      } catch (cleanup_error) {
        throw new AggregateError(
          [mismatch, cleanup_error],
          "Wasm adapter identity mismatch and guest cleanup also failed",
        );
      }
      throw mismatch;
    }
    return guest;
  } catch (cause) {
    throw new Error(
      `guest ${JSON.stringify(artifact.guest_id)} artifact ${
        JSON.stringify(artifact.artifact_digest)
      } failed Wasm adapter creation`,
      { cause },
    );
  }
}
