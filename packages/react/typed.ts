/** Bind ordinary session hooks to a project's generated World type. */
import type { EntityModel, WorldModel } from "@ink/schema";
import { jsonEqual, useSessionValue } from "./context.tsx";

export function createSchemaHooks<W extends WorldModel>() {
  type E = W["entities"][number];
  type C = E["components"];
  type R = W["resources"];
  return {
    useWorld(): W {
      return useSessionValue((s) => s.world as W);
    },
    useEntity(id: number | undefined): E | undefined {
      return useSessionValue(
        (s) => s.entity(id ?? 0) as E | undefined,
        jsonEqual,
      );
    },
    useComponent<K extends keyof C & string>(
      id: number | undefined,
      name: K,
    ): C[K] | undefined {
      return useSessionValue(
        (s) => s.entity(id ?? 0)?.components[name] as C[K] | undefined,
        jsonEqual,
      );
    },
    useResource<K extends keyof R & string>(name: K): R[K] {
      return useSessionValue((s) => s.world.resources[name] as R[K], jsonEqual);
    },
    useEntities(select: (entity: E) => boolean): E[] {
      return useSessionValue(
        (s) =>
          s.world.entities.filter((e: EntityModel) => select(e as E)) as E[],
        jsonEqual,
      );
    },
  };
}
