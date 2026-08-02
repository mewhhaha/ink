export const game_updated_event = "ink:game-updated";

export interface GameUpdateChannel {
  on(event: typeof game_updated_event, callback: () => void): void;
  off(event: typeof game_updated_event, callback: () => void): void;
}

export function subscribe_to_game_updates(
  channel: GameUpdateChannel,
  callback: () => void,
): () => void {
  channel.on(game_updated_event, callback);
  return () => channel.off(game_updated_event, callback);
}
