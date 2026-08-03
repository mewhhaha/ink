import { ink } from "@ink/development/vite.ts";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { isometric_city_development } from "./development.ts";

export default defineConfig(({ command }) => ({
  define: command === "build"
    ? { "process.env.NODE_ENV": JSON.stringify("production") }
    : undefined,
  plugins: [
    ink(isometric_city_development),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  server: {
    open: false,
  },
  build: {
    emptyOutDir: true,
    minify: "oxc",
  },
}));
