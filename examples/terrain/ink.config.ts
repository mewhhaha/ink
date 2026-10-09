import { defineProject } from "@ink/dev";

export default defineProject({
  "title": "Terrain Lab",
  // The ground textures and scatter meshes are small files: import them all so
  // every layer is KTX2 and the trees get their detail levels.
  "import": { "minBytes": 0 },
  "player": {
    "pointerLock": false,
  },
});
