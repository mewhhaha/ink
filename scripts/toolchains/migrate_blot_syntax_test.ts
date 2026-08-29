import { assertEquals } from "@std/assert";
import { migrate_blot_source } from "./migrate_blot_syntax.ts";

Deno.test("Blot effect sequencing receives the explicit use keyword", () => {
  const source = `value <- Clock.read ()
  <- Clock.write value
use current <- Clock.read ()
let member = record.use
// value <- documented legacy syntax
`;

  assertEquals(
    migrate_blot_source(source),
    `use value <- Clock.read ()
  use Clock.write value
use current <- Clock.read ()
let member = record.use
// value <- documented legacy syntax
`,
  );
});

Deno.test("Blot syntax migration is idempotent", () => {
  const source = `use value <- Clock.read ()
use Clock.write value
`;

  assertEquals(migrate_blot_source(migrate_blot_source(source)), source);
});
