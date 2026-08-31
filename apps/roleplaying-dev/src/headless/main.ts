import { play_generated_roleplaying } from "./scenario.ts";

if (import.meta.main) {
  const playthrough = await play_generated_roleplaying();
  console.log(JSON.stringify(
    {
      outcome: playthrough.completed.observation.status,
      snapshot_checksum: playthrough.snapshot_checksum,
      replay_checksum: playthrough.replay_checksum,
    },
    null,
    2,
  ));
}
