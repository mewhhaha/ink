import {
  dialog,
  listbox,
  menu,
  navigate,
  type Navigation,
  slider,
} from "@ink/blot/ui";
import {
  applyPreferences,
  subtitles,
  systemPreferences,
} from "@ink/blot/accessibility";
import { input } from "@ink/blot/input";
import { play } from "@ink/blot/audio";
const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const preferences = systemPreferences(window);
const caption = subtitles(get("cue"));
const pause = dialog(get<HTMLDialogElement>("pause-dialog"));
const field = get("field");
const controls = input(field, {
  explore: {
    scan: [{ device: "keyboard", code: "Space" }, {
      device: "gamepad",
      button: 0,
    }],
  },
  paused: {},
}, "explore");
const gamepadUI = input(document.body, {
  ui: {
    next: [{ device: "gamepad", button: 5 }],
    previous: [{ device: "gamepad", button: 4 }],
    up: [{ device: "gamepad", button: 12 }],
    down: [{ device: "gamepad", button: 13 }],
    left: [{ device: "gamepad", button: 14 }],
    right: [{ device: "gamepad", button: 15 }],
    activate: [{ device: "gamepad", button: 0 }],
    cancel: [{ device: "gamepad", button: 1 }],
  },
}, "ui");
const cleanup: { dispose(): void }[] = [caption, pause, controls, gamepadUI];
let audio: AudioContext | undefined;
let volume = 0.3;
const voices: ReturnType<typeof play>[] = [];
function apply() {
  applyPreferences(document.documentElement, preferences);
  get<HTMLInputElement>("motion").checked = preferences.reducedMotion;
  get<HTMLInputElement>("contrast").checked = preferences.highContrast;
  caption.show({
    speaker: "Receiver",
    kind: "signal",
    direction: "ahead",
    text: "Three clear tones. The station answers.",
  }, preferences.subtitles);
}
async function scan() {
  caption.show({
    speaker: "Receiver",
    kind: "signal",
    direction: "ahead",
    text: "Three clear tones. The station answers.",
  }, preferences.subtitles);
  audio ??= new AudioContext();
  await audio.resume();
  const buffer = audio.createBuffer(
    1,
    audio.sampleRate * 0.6,
    audio.sampleRate,
  );
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin(i / audio.sampleRate * Math.PI * 2 * 660) * 0.25;
  }
  for (const voice of voices) voice.dispose();
  voices.length = 0;
  const voice = play(audio, buffer, {
    gain: volume,
    pan: 0.3,
    rate: 1,
    cutoff: 16000,
  }, { fade: 0.03 });
  voice.stop(0.1, audio.currentTime + 0.45);
  voices.push(voice);
}
get("scan").onclick = () => {
  void scan();
};
get("pause").onclick = () => {
  controls.setContext("paused");
  pause.open();
};
get("resume").onclick = () => pause.close();
get("pause-dialog").addEventListener(
  "close",
  () => controls.setContext("explore"),
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !get<HTMLDialogElement>("pause-dialog").open) {
    event.preventDefault();
    controls.setContext("paused");
    pause.open();
  }
});
cleanup.push(
  menu(
    get("station-menu"),
    get<HTMLButtonElement>("menu-trigger"),
    (button) => {
      pause.close();
      if (button.dataset.action === "scan") void scan();
      else get("motion").focus();
    },
  ),
);
cleanup.push(listbox(get<HTMLSelectElement>("inventory"), (values) => {
  get("selected").textContent = `${values.join(", ")} equipped`;
}));
cleanup.push(slider(get<HTMLInputElement>("volume"), (value) => {
  volume = value / 100;
}));
cleanup.push(slider(get<HTMLInputElement>("scale"), (value) => {
  preferences.uiScale = value / 100;
  get("scale-value").textContent = `${value}%`;
  apply();
}));
get<HTMLInputElement>("motion").onchange = (event) => {
  preferences.reducedMotion = (event.target as HTMLInputElement).checked;
  apply();
};
get<HTMLInputElement>("contrast").onchange = (event) => {
  preferences.highContrast = (event.target as HTMLInputElement).checked;
  apply();
};
get<HTMLInputElement>("captions").onchange = (event) => {
  preferences.subtitles = (event.target as HTMLInputElement).checked;
  apply();
};
get("rebind").onclick = () => {
  controls.rebind("explore", "scan", [{ device: "keyboard", code: "Enter" }, {
    device: "gamepad",
    button: 0,
  }]);
};
let frame = 0;
function poll() {
  const pads = navigator.getGamepads();
  const snapshot = controls.sample(pads);
  const ui = gamepadUI.sample(pads);
  for (const [action, state] of Object.entries(ui.actions)) {
    if (state.pressed) navigate(document.body, action as Navigation);
  }
  if (snapshot.actions.scan?.pressed) void scan();
  get("prompt").textContent = `${controls.prompt("scan")} · scan the signal`;
  frame = requestAnimationFrame(poll);
}
apply();
poll();
globalThis.addEventListener("pagehide", () => {
  cancelAnimationFrame(frame);
  for (const handle of cleanup) handle.dispose();
  for (const voice of voices) voice.dispose();
  void audio?.close();
}, { once: true });
Object.assign(globalThis, { inkReady: true });
