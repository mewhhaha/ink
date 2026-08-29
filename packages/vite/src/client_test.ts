import assert from "node:assert/strict";
import { test } from "node:test";
import {
  application_updated_event,
  type ApplicationUpdate,
  type ApplicationUpdateChannel,
  subscribe_to_application_updates,
} from "./client.ts";

test("application updates notify subscribers until they unsubscribe", () => {
  const callbacks = new Set<(update: ApplicationUpdate) => void>();
  const channel: ApplicationUpdateChannel = {
    on(event, callback) {
      assert.equal(event, application_updated_event);
      callbacks.add(callback);
    },
    off(event, callback) {
      assert.equal(event, application_updated_event);
      callbacks.delete(callback);
    },
  };
  let update_count = 0;
  const unsubscribe = subscribe_to_application_updates(
    channel,
    () => update_count += 1,
  );

  for (const callback of callbacks) callback({ type: "game" });
  assert.equal(update_count, 1);

  unsubscribe();
  for (const callback of callbacks) callback({ type: "resources" });
  assert.equal(update_count, 1);
});
