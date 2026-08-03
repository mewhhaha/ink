import type { GameDevelopmentContext } from "@ink/development/game_development.tsx";
import { city_tools } from "./city_editor_logic.ts";

const tool_preview_urls: Readonly<Record<string, string>> = {
  "city-tool-path": "/assets/terrain-road.webp",
  "city-tool-plot": "/assets/tent-placeholder.png",
  "city-tool-well": "/assets/terrain-detail-rocks.png",
  "city-tool-marshal": "/assets/tent-placeholder.png",
};

export function CityEditor(
  { observation, can_interact, dispatch_game_action }: GameDevelopmentContext,
) {
  "use memo";

  const tools = city_tools(observation);

  return (
    <aside className="city-editor" aria-label="City building tools">
      <header className="city-editor__header">
        <p className="city-editor__eyebrow">Construction</p>
        <h1 className="city-editor__title">Build</h1>
      </header>
      <div className="city-editor__tools">
        {tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className="city-tool"
            disabled={!can_interact}
            data-selected={tool.selected || undefined}
            aria-pressed={tool.selected}
            onClick={() => void dispatch_game_action(tool.action)}
          >
            <img
              className="city-tool__preview"
              src={tool_preview_urls[tool.id]}
              alt=""
            />
            <span className="city-tool__label">{tool.label}</span>
          </button>
        ))}
      </div>
      <p className="city-editor__hint">
        {can_interact
          ? "Select a tool, then click or drag across the map."
          : "Press Play to build on the map."}
      </p>
    </aside>
  );
}
