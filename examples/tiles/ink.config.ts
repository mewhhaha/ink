import { defineProject } from "@ink/dev";

export default defineProject({
  "title": "Tile Lab",
  "player": {
    "pointerLock": false,
    "stats": [
      { "label": "Coins", "resource": "game", "field": "coins" },
      { "label": "Time", "resource": "game", "field": "time" },
    ],
  },
});
