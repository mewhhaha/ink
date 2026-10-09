# Shipping a game

`deno task ink build examples/feel` writes `examples/feel/dist/`. Serve that
directory over HTTPS (or localhost). All URLs are relative, including meshes,
textures, sounds and external glTF buffers, so it can live under a subdirectory.
It contains the compiled game, schema, initial scene, assets and `@ink/player`;
the bundler rejects editor, React and dev-server modules. The renderer requires
WebGPU. `ink-build.json` lists file sizes and SHA-256 hashes.

Assets are imported first (`docs/assets.md`): textures ship as Basis KTX2 with
mips, models as meshopt-compressed GLB with simplified levels, sounds as Ogg
Opus, each stored as `assets/<path>.ink.<ext>` and listed in
`assets/ink-assets.json` (catalog path to stored file), which the player reads
before creating its renderer. Small and unsupported assets are copied as they
are. The cache in `.ink/cache` makes repeated builds a copy.

The default scene is `main`; `--scene name` and `--out directory` override it.
Compilation and asset copying happen in staging. A successful build replaces the
previous output; failures leave it intact. An existing output directory must
have an Ink build manifest. Outputs inside source assets are refused.

`ink.config.ts` can set shipping presentation independently of the editor:

```ts
export default defineProject({
  title: "My game",
  player: {
    scene: "main",
    tickRate: 60,
    pointerLock: true,
    stats: [{ label: "Health", resource: "stats", field: "health" }],
  },
});
```

The player runs the same pure steps at a fixed rate. It pauses on blur and
visibility changes. Escape opens the menu; Play/Resume restores control.
Bindings save per hosted path. Click a binding and press a keyboard key or
gamepad button; Backspace clears it, Escape cancels. Keyboard rebinding keeps
default gamepad mappings; explicit gamepad bindings replace those defaults. The
first connected controller uses the left stick for movement, right stick for
look/turn, A for jump, RT for fire and X for interaction. Analog sticks have a
dead zone. Touch screens get a movement stick and action buttons; dragging the
view looks around. Short taps retain their pressed edge between ticks.

`deno task ink build examples/feel --desktop` also writes `dist-desktop/` for
the host operating system and architecture. It bundles Electron 44.7.0 and the
static game with `@electron/packager` 20.3.0. Run the executable inside that
folder; no editor, Deno or HTTP server is required. The browser process uses a
secure local asset protocol and has no Node access. Linux uses Vulkan for
WebGPU. Desktop runtimes are larger than the web payload. Linux x64 is verified;
macOS/Windows packaging is supported by the packager but has not been run here.
Code signing and store submission are separate distribution steps. See
[Electron distribution](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)
and
[Packager options](https://electron.github.io/packager/main/interfaces/Options.html).

`deno task test:build` builds every example, serves only production files under
`/play/<name>/`, plays each, checks saved rebinding and performs a touch jump.
`deno run -A scripts/build-smoke.ts --hardware --headed` requires a hardware
adapter and checks first-frame startup under two seconds. The measured NVIDIA
run was 265–568 ms for all four games. The web payloads are 0.29–0.37 MB plus
assets. SwiftShader runs the same functionality but first frames take 2–11 s.
`deno task test:desktop` launches the packaged Linux Feel Lab and checks play.
Screenshots and timings go in `tmp/`.
