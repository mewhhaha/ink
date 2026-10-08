import { assertEquals, assertThrows } from "@std/assert";
import { defineSchema, textId } from "@ink/schema";
import { Session } from "./session.ts";

Deno.test("language switches preserve packets, fall back and survive schema reload", () => {
  const schema = defineSchema({
    messages: { won: "Won {0}", fallback: "Hello {0}" },
    locales: { pl: { won: "Wygrana {0}" } },
  });
  const session = new Session({ schema, catalog: { assets: {} } });
  const state = session.state;
  assertEquals(session.message("won", 3), "Won 3");
  session.setLocale("pl");
  assertEquals(session.message("won", 3), "Wygrana 3");
  assertEquals(session.message("fallback", "Ada"), "Hello Ada");
  assertEquals(session.state, state);
  assertThrows(() => session.setLocale("unknown"));
  const next = defineSchema({
    messages: { won: "Won {0}", fallback: "Hello {0}" },
    locales: { pl: { won: "Zwycięstwo {0}" } },
  });
  assertEquals(next.hash, schema.hash, "translations do not change layout");
  session.setProject(next, session.catalog);
  assertEquals(session.locale, "pl");
  assertEquals(session.message("won", 4), "Zwycięstwo 4");
  session.dispose();
});

Deno.test("entity name ids track edits, undo, saved scenes and guest renames", () => {
  const schema = defineSchema({ names: { renamed: "Renamed" } });
  const session = new Session({
    schema,
    catalog: { assets: {} },
    scene: { ink: 1, entities: [{ id: 1, name: "Player", components: {} }] },
  });
  assertEquals(session.entity(1)?.nameId, textId("Player"));
  session.rename(1, "Other");
  assertEquals(session.entity(1)?.nameId, textId("Other"));
  session.undo();
  assertEquals(session.entity(1)?.nameId, textId("Player"));
  session.edit("Guest name", (world) => {
    world.entities[0].nameId = textId("Renamed");
  });
  assertEquals(session.nameOf(1), "Renamed");
  assertEquals(session.toScene().entities[0].name, "Renamed");
  session.rename(1, "");
  assertEquals(session.entity(1)?.nameId, undefined);
  session.dispose();
});
