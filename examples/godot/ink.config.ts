import { defineProject } from "@ink/dev";

export default defineProject({
  "title": "Ink Scene",
  "player": {
    "pointerLock": false,
    "stats": [
      {
        "label": "Coins",
        "resource": "score",
        "field": "value",
      },
      {
        "label": "Total",
        "resource": "score",
        "field": "total",
      },
    ],
  },
});
