export type GameDevelopmentView = "editor" | "debug" | "game";

const view_paths: Readonly<Record<GameDevelopmentView, string>> = {
  editor: "/editor",
  debug: "/debug",
  game: "/game",
};

export function game_development_path(view: GameDevelopmentView): string {
  const path = view_paths[view];
  if (!path) {
    throw new Error(
      `game development view ${JSON.stringify(view)} is unsupported`,
    );
  }
  return path;
}

export function resolve_game_development_view(
  pathname: string,
  root_view: GameDevelopmentView = "editor",
): GameDevelopmentView {
  if (pathname === "/") return root_view;
  if (pathname === "/editor" || pathname === "/editor/") return "editor";
  if (pathname === "/debug" || pathname === "/debug/") return "debug";
  if (pathname === "/game" || pathname === "/game/") return "game";
  throw new Error(
    `game development pathname ${
      JSON.stringify(pathname)
    } is unsupported; use "/editor", "/debug", or "/game"`,
  );
}
