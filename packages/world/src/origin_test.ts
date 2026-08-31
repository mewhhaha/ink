import { vec3 } from "@ink/math/vector.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { global_position, local_origin } from "./identity.ts";
import { OriginRebaser } from "./experimental/origin.ts";

Deno.test("origin shifts stage and commit adapters in identity order", async () => {
  const operations: string[] = [];
  const origin = local_origin(global_position(0, 0, vec3(0, 0, 0), 10));
  const rebaser = new OriginRebaser({
    cell_size: 10,
    threshold: 5,
    origin,
    adapters: ["visibility", "camera", "physics"].map((id) => ({
      id,
      stage: () => {
        operations.push(`stage ${id}`);
        return {
          commit: () => operations.push(`commit ${id}`),
          rollback: () => operations.push(`rollback ${id}`),
        };
      },
    })),
  });
  const event = await rebaser.rebase_if_needed(
    global_position(1, 0, vec3(2, 3, 0), 10),
  );
  assertEquals(event, {
    sequence: 1,
    previous: origin,
    current: global_position(1, 0, vec3(2, 3, 0), 10),
    local_translation: vec3(-12, -3, 0),
  });
  assertEquals(operations, [
    "stage camera",
    "stage physics",
    "stage visibility",
    "commit camera",
    "commit physics",
    "commit visibility",
  ]);
});

Deno.test("failed origin staging rolls back and preserves the current origin", async () => {
  const operations: string[] = [];
  const origin = local_origin(global_position(0, 0, vec3(0, 0, 0), 10));
  const rebaser = new OriginRebaser({
    cell_size: 10,
    threshold: 1,
    origin,
    adapters: [
      {
        id: "camera",
        stage: () => ({
          commit: () => operations.push("commit camera"),
          rollback: () => operations.push("rollback camera"),
        }),
      },
      {
        id: "physics",
        stage: () => {
          throw new Error("physics busy");
        },
      },
    ],
  });
  await assertRejects(
    () =>
      rebaser.rebase(local_origin(global_position(2, 0, vec3(0, 0, 0), 10))),
    Error,
    "physics busy",
  );
  assertEquals(operations, ["rollback camera"]);
  assertEquals(rebaser.origin, origin);
});
