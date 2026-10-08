import { defineProject } from "@ink/dev";

export default defineProject({
  "title": "Feel Lab",
  "player": {
    "pointerLock": false,
    "stats": [
      {
        "label": "Jumps",
        "resource": "run",
        "field": "jumps",
      },
      {
        "label": "Time",
        "resource": "run",
        "field": "time",
      },
    ],
  },
});
