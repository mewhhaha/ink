import { assertEquals } from "@std/assert";
import {
  game_updated_event,
  type GameUpdateChannel,
  subscribe_to_game_updates,
} from "./hot_reload.ts";

Deno.test("game updates notify subscribers until they unsubscribe", () => {
  const callbacks = new Set<() => void>();
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

  for (const callback of callbacks) callback();
  assertEquals(update_count, 1);

  unsubscribe();
  for (const callback of callbacks) callback();
  assertEquals(update_count, 1);
});
