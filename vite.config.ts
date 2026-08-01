import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  publicDir: "generated",
  define: command === "build"
    ? { "process.env.NODE_ENV": JSON.stringify("production") }
    : undefined,
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@mewhhaha/typeclasses": fileURLToPath(
        new URL(
          "./vendor/jsr.io/@mewhhaha/typeclasses/0.8.0/src/mod.ts",
          import.meta.url,
        ),
      ),
    },
  },
  build: {
    emptyOutDir: true,
    minify: "oxc",
    lib: {
      entry: fileURLToPath(new URL("./editor/main.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "editor.js",
      cssFileName: "editor",
    },
    outDir: "public",
  },
}));
