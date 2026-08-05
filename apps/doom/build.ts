import { decode_doom_picture, doom_picture_rgba } from "./src/doom_picture.ts";
import { decode_doom_sound, encode_wav_pcm8 } from "./src/doom_sound.ts";
import { encode_png_rgba } from "./src/png.ts";
import { parse_wad } from "./src/wad.ts";

const app_directory = new URL("./", import.meta.url);
const compiler_directory = new URL("vendor/blot/", app_directory);
const compiler_config = new URL("deno.json", compiler_directory);
const compiler_cli = new URL("src/cli.ts", compiler_directory);
const game_source = new URL("blot/game/main.blot", app_directory);
const game_wasm = new URL("blot/game/main.wasm", app_directory);
const game_manifest = new URL("blot/game/main.wasm.json", app_directory);
const freedoom_wad = new URL(
  "assets/freedoom/release/freedoom-0.13.0/freedoom1.wad",
  app_directory,
);
const generated_directory = new URL("generated/", app_directory);
const generated_wasm = new URL("doom-menu.wasm", generated_directory);
const generated_manifest = new URL(
  "doom-menu.manifest.json",
  generated_directory,
);
const generated_titlepic = new URL(
  "freedoom-titlepic.png",
  generated_directory,
);
const generated_logo = new URL(
  "freedoom-menu-logo.png",
  generated_directory,
);
const pending_titlepic = new URL(
  `.freedoom-titlepic.${Deno.pid}.tmp`,
  generated_directory,
);
const pending_logo = new URL(
  `.freedoom-menu-logo.${Deno.pid}.tmp`,
  generated_directory,
);
const generated_menu_move = new URL(
  "freedoom-menu-move.wav",
  generated_directory,
);
const generated_menu_activate = new URL(
  "freedoom-menu-activate.wav",
  generated_directory,
);
const pending_menu_move = new URL(
  `.freedoom-menu-move.${Deno.pid}.tmp`,
  generated_directory,
);
const pending_menu_activate = new URL(
  `.freedoom-menu-activate.${Deno.pid}.tmp`,
  generated_directory,
);
const pending_wasm = new URL(
  `.doom-menu.wasm.${Deno.pid}.tmp`,
  generated_directory,
);
const pending_manifest = new URL(
  `.doom-menu.manifest.json.${Deno.pid}.tmp`,
  generated_directory,
);

await Deno.mkdir(generated_directory, { recursive: true });

const build = new Deno.Command(Deno.execPath(), {
  cwd: app_directory,
  args: [
    "run",
    "--config",
    compiler_config.pathname,
    "--allow-read",
    "--allow-write",
    compiler_cli.pathname,
    "build",
    game_source.pathname,
  ],
  stdout: "inherit",
  stderr: "inherit",
});
const result = await build.output();
if (!result.success) {
  throw new Error(`Blot build exited with code ${result.code}`);
}

try {
  const manifest = JSON.parse(await Deno.readTextFile(game_manifest)) as {
    source?: string;
  };
  manifest.source = "blot/game/main.blot";

  const wad = parse_wad(await Deno.readFile(freedoom_wad));
  const title_picture = decode_doom_picture(wad.read("TITLEPIC"));
  const title_rgba = doom_picture_rgba(title_picture, wad.read("PLAYPAL"));
  const title_png = await encode_png_rgba(
    title_picture.width,
    title_picture.height,
    title_rgba,
  );
  const logo_picture = decode_doom_picture(wad.read("M_DOOM"));
  const logo_rgba = doom_picture_rgba(logo_picture, wad.read("PLAYPAL"));
  const logo_png = await encode_png_rgba(
    logo_picture.width,
    logo_picture.height,
    logo_rgba,
  );
  const menu_move_wav = encode_wav_pcm8(
    decode_doom_sound(wad.read("DSSTNMOV")),
  );
  const menu_activate_wav = encode_wav_pcm8(
    decode_doom_sound(wad.read("DSPISTOL")),
  );

  await Promise.all([
    Deno.copyFile(game_wasm, pending_wasm),
    Deno.writeTextFile(
      pending_manifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
    Deno.writeFile(pending_titlepic, title_png),
    Deno.writeFile(pending_logo, logo_png),
    Deno.writeFile(pending_menu_move, menu_move_wav),
    Deno.writeFile(pending_menu_activate, menu_activate_wav),
  ]);
  await Promise.all([
    Deno.rename(pending_wasm, generated_wasm),
    Deno.rename(pending_manifest, generated_manifest),
    Deno.rename(pending_titlepic, generated_titlepic),
    Deno.rename(pending_logo, generated_logo),
    Deno.rename(pending_menu_move, generated_menu_move),
    Deno.rename(pending_menu_activate, generated_menu_activate),
  ]);
} finally {
  await Promise.all([
    remove_if_present(game_wasm),
    remove_if_present(game_manifest),
    remove_if_present(pending_wasm),
    remove_if_present(pending_manifest),
    remove_if_present(pending_titlepic),
    remove_if_present(pending_logo),
    remove_if_present(pending_menu_move),
    remove_if_present(pending_menu_activate),
  ]);
}

async function remove_if_present(path: URL): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
