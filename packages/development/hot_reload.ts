export const game_updated_event = "ink:game-updated";

export type GameUpdate =
  | { readonly type: "game" }
  | { readonly type: "resources" }
  | { readonly type: "resource_error"; readonly message: string }
  | { readonly type: "compilation_error"; readonly message: string };

export interface GameUpdateChannel {
  on(
    event: typeof game_updated_event,
    callback: (update: GameUpdate) => void,
  ): void;
  off(
    event: typeof game_updated_event,
    callback: (update: GameUpdate) => void,
  ): void;
}

export function subscribe_to_game_updates(
  channel: GameUpdateChannel,
  callback: (update: GameUpdate) => void,
): () => void {
  channel.on(game_updated_event, callback);
  return () => channel.off(game_updated_event, callback);
}
