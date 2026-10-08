import { defineProject } from "@ink/dev";

export default defineProject({
  "title": "Ink Brush Editor",
  "player": {
    "pointerLock": true,
    "stats": [
      {
        "label": "Health",
        "resource": "stats",
        "field": "health",
      },
      {
        "label": "Ammo",
        "resource": "stats",
        "field": "ammo",
      },
      {
        "label": "Secrets",
        "resource": "stats",
        "field": "found",
      },
    ],
  },
});
