import { defineProject } from "@ink/dev";

export default defineProject({
  "title": "Ink Hammer",
  "player": {
    "pointerLock": true,
    "stats": [
      {
        "label": "Buttons",
        "resource": "game",
        "field": "presses",
      },
      {
        "label": "Complete",
        "resource": "game",
        "field": "finished",
      },
    ],
  },
});
