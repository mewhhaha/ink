import { assertEquals } from "@std/assert";
import {
  game_updated_event,
  type GameUpdate,
  type GameUpdateChannel,
  subscribe_to_game_updates,
} from "./hot_reload.ts";

Deno.test("game updates notify subscribers until they unsubscribe", () => {
  const callbacks = new Set<(update: GameUpdate) => void>();
  const channel: GameUpdateChannel = {
    on(event, callback) {
      assertEquals(event, game_updated_event);
      callbacks.add(callback);
    },
    off(event, callback) {
      assertEquals(event, game_updated_event);
      callbacks.delete(callback);
    },
  };
  let update_count = 0;
  const unsubscribe = subscribe_to_game_updates(
    channel,
    () => update_count += 1,
  );

  for (const callback of callbacks) callback({ type: "game" });
  assertEquals(update_count, 1);

  unsubscribe();
  for (const callback of callbacks) callback({ type: "resources" });
  assertEquals(update_count, 1);
});
