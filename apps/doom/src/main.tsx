import { mount_game_development } from "@ink/development/mount_game_development.tsx";
import { doom_assets } from "../game.ts";
import { load_doom_artifact } from "./wasm_game.ts";
import "./doom.css";

const root = document.getElementById("root");
if (!root) throw new Error("doom root element is missing");

let generated_asset_revision = 0;
const generated_asset_url = (url: string): string =>
  `${url}?v=${generated_asset_revision}`;
let active_freedoom_font: FontFace | undefined;

async function load_freedoom_font(): Promise<void> {
  const font = new FontFace(
    "Freedoom",
    `url("${generated_asset_url(doom_assets.font_url)}")`,
  );
  try {
    const loaded = await font.load();
    if (active_freedoom_font) document.fonts.delete(active_freedoom_font);
    document.fonts.add(loaded);
    active_freedoom_font = loaded;
    const canvas = document.querySelector("ink-game-surface")?.shadowRoot
      ?.querySelector("canvas");
    canvas?.dispatchEvent(new Event("paint"));
  } catch (error) {
    console.warn("Freedoom bitmap font could not be loaded", error);
  }
}

void load_freedoom_font();

mount_game_development(root, {
  assets: doom_assets,
  load_artifact: load_doom_artifact,
  logical_viewport: { width: 320, height: 200 },
  always_enable_semantic_buttons: true,
  keyboard_actions: {
    arrowup: "doom-menu-up",
    w: "doom-menu-up",
    arrowdown: "doom-menu-down",
    s: "doom-menu-down",
    enter: "doom-menu-activate",
    " ": "doom-menu-activate",
  },
  show_debugger: false,
  show_metrics: false,
  render_editor: () => (
    <>
      <img
        className="doom-freedoom-titlepic"
        src={generated_asset_url(doom_assets.titlepic_url)}
        alt=""
        aria-hidden="true"
      />
      <img
        className="doom-freedoom-logo"
        src={generated_asset_url(doom_assets.logo_url)}
        alt="DOOM"
        aria-hidden="true"
      />
    </>
  ),
});

const menu_move_sound = new Audio(
  generated_asset_url(doom_assets.menu_move_url),
);
const menu_activate_sound = new Audio(
  generated_asset_url(doom_assets.menu_activate_url),
);
menu_move_sound.volume = 0.22;
menu_activate_sound.volume = 0.18;

const movement_keys = new Set(["arrowup", "w", "arrowdown", "s"]);
const activation_keys = new Set(["enter", " "]);

function play_menu_sound(sound: HTMLAudioElement): void {
  sound.currentTime = 0;
  void sound.play().catch(() => {
    // Browsers may reject playback until the first user gesture.
  });
}

function handle_menu_keydown(event: KeyboardEvent): void {
  const key = event.key.toLowerCase();
  if (movement_keys.has(key)) play_menu_sound(menu_move_sound);
  else if (activation_keys.has(key)) play_menu_sound(menu_activate_sound);
}

function handle_menu_pointerdown(event: PointerEvent): void {
  if (event.composedPath().some((target) => target instanceof HTMLButtonElement)) {
    play_menu_sound(menu_activate_sound);
  }
}

document.addEventListener("keydown", handle_menu_keydown, true);
document.addEventListener("pointerdown", handle_menu_pointerdown, true);

function refresh_generated_assets(): void {
  generated_asset_revision += 1;
  const titlepic = document.querySelector<HTMLImageElement>(
    ".doom-freedoom-titlepic",
  );
  if (titlepic) {
    titlepic.src = generated_asset_url(doom_assets.titlepic_url);
  }
  const logo = document.querySelector<HTMLImageElement>(
    ".doom-freedoom-logo",
  );
  if (logo) logo.src = generated_asset_url(doom_assets.logo_url);
  menu_move_sound.src = generated_asset_url(doom_assets.menu_move_url);
  menu_activate_sound.src = generated_asset_url(
    doom_assets.menu_activate_url,
  );
  menu_move_sound.load();
  menu_activate_sound.load();
  void load_freedoom_font();
}

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.on("ink:game-updated", refresh_generated_assets);
  import.meta.hot.dispose(() => {
    import.meta.hot?.off("ink:game-updated", refresh_generated_assets);
    document.removeEventListener("keydown", handle_menu_keydown, true);
    document.removeEventListener("pointerdown", handle_menu_pointerdown, true);
  });
}
