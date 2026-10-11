import { dialog, listbox, menu, navigate, slider } from "../adapters/ui.ts";
import {
  applyPreferences,
  subtitles,
  systemPreferences,
} from "../adapters/accessibility.ts";
import { input } from "../adapters/input.ts";
import { play } from "../adapters/audio.ts";
const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
const modal = dialog(get<HTMLDialogElement>("dialog"));
get("open").onclick = () => modal.open();
get("resume").onclick = () => modal.close();
let selected = "";
const popup = menu(get("menu"), get<HTMLButtonElement>("trigger"), (button) => {
  selected = button.id;
});
let inventory: string[] = [];
let scale = 0;
const inventoryControl = listbox(
  get<HTMLSelectElement>("inventory"),
  (values) => {
    inventory = values;
  },
);
const scaleControl = slider(get<HTMLInputElement>("scale"), (value) => {
  scale = value;
});
const root = get("root");
const controls = input(root, {
  game: {
    jump: [{ device: "keyboard", code: "Space" }, {
      device: "pointer",
      button: 0,
    }, { device: "gamepad", button: 0 }],
    move: [{ device: "gamepad", axis: 0, deadzone: 0.2 }],
  },
  menu: { accept: [{ device: "keyboard", code: "Enter" }] },
}, "game");
function key(type: string, code: string, target = root) {
  target.dispatchEvent(
    new KeyboardEvent(type, { code, bubbles: true, cancelable: true }),
  );
}
function testInput() {
  root.focus();
  key("keydown", "Space");
  equal(controls.sample().actions.jump, {
    value: 1,
    down: true,
    pressed: true,
    released: false,
  });
  equal(controls.sample().actions.jump.pressed, false);
  key("keydown", "Space");
  equal(controls.sample().actions.jump.pressed, false);
  key("keyup", "Space");
  equal(controls.sample().actions.jump.released, true);
  key("keydown", "Space");
  key("keyup", "Space");
  const tap = controls.sample().actions.jump;
  equal([tap.down, tap.pressed, tap.released], [false, true, true]);
  key("keydown", "Space", get("editable"));
  equal(controls.sample().actions.jump.down, false);
  const pad = { connected: true, axes: [0.6], buttons: [{ value: 1 }] };
  const state = controls.sample([pad]);
  equal(state.device, "gamepad");
  equal(state.actions.jump.pressed, true);
  equal(Math.round(state.actions.move.value * 1000), 500);
  equal(controls.prompt("jump"), "A / Cross");
  key("keydown", "Space");
  equal(
    controls.sample([{ ...pad, buttons: [{ value: 0 }] }]).actions.jump.down,
    true,
  );
  globalThis.dispatchEvent(new Event("blur"));
  equal(controls.sample([pad]).actions.jump.released, true);
  equal(controls.sample([pad]).actions.jump.down, false);
  globalThis.dispatchEvent(new Event("focus"));
  root.dispatchEvent(
    new PointerEvent("pointerdown", { button: 0, pointerId: 7, bubbles: true }),
  );
  equal(controls.sample().actions.jump.pressed, true);
  globalThis.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 7 }));
  equal(controls.sample().actions.jump.released, true);
  controls.rebind("game", "jump", [{ device: "keyboard", code: "KeyJ" }]);
  key("keydown", "Space");
  equal(controls.sample().actions.jump.down, false);
  key("keydown", "KeyJ");
  equal(controls.sample().actions.jump.pressed, true);
  get("after").focus();
  equal(controls.sample().actions.jump.released, true);
  controls.setContext("menu");
  root.focus();
  key("keydown", "Enter");
  equal(controls.sample().actions.accept.pressed, true);
  controls.dispose();
  key("keydown", "Enter");
  equal(controls.sample().actions.accept.down, false);
  return true;
}
function testPreferences() {
  applyPreferences(root, {
    reducedMotion: true,
    uiScale: 1.5,
    subtitles: true,
    highContrast: true,
  });
  equal(root.hasAttribute("data-reduced-motion"), true);
  equal(root.style.getPropertyValue("--ink-ui-scale"), "1.5");
  const caption = subtitles(get("captions"));
  caption.show({
    speaker: "Guard",
    direction: "left",
    kind: "footsteps",
    text: "Approaching",
  });
  equal(get("captions").textContent, "Guard: [footsteps] (left) Approaching");
  caption.show({ text: "Hidden" }, false);
  equal(get("captions").textContent, "");
  equal(get("captions").hidden, true);
  return true;
}
async function testNavigation() {
  const scope = document.body;
  get("open").focus();
  equal(navigate(scope, "next"), true);
  equal(document.activeElement?.id, "after");
  get<HTMLButtonElement>("before").disabled = true;
  navigate(scope, "previous");
  equal(document.activeElement?.id, "open");
  navigate(scope, "previous");
  equal(document.activeElement?.id, "editable");
  get<HTMLButtonElement>("before").disabled = false;
  get("inventory").focus();
  navigate(scope, "up");
  equal(inventory, ["one"]);
  navigate(scope, "down");
  equal(inventory, ["two"]);
  get("scale").focus();
  navigate(scope, "right");
  equal(scale, 102);
  navigate(scope, "left");
  equal(scale, 101);
  get("open").focus();
  navigate(scope, "activate");
  equal(document.activeElement?.id, "resume");
  navigate(scope, "next");
  equal(document.activeElement?.id, "trigger");
  navigate(scope, "next");
  equal(document.activeElement?.id, "resume");
  popup.open(true);
  navigate(scope, "up");
  equal(document.activeElement?.id, "first");
  navigate(scope, "activate");
  equal(selected, "first");
  popup.open();
  navigate(scope, "cancel");
  equal(document.activeElement?.id, "trigger");
  equal(get<HTMLDialogElement>("dialog").open, true);
  navigate(scope, "cancel");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(get<HTMLDialogElement>("dialog").open, false);
  equal(document.activeElement?.id, "open");
  return true;
}
async function testAudio() {
  const context = new OfflineAudioContext(2, 48000, 48000);
  const buffer = context.createBuffer(1, 48000, 48000);
  buffer.getChannelData(0).fill(1);
  const voice = play(context, buffer, {
    gain: 0.5,
    pan: 1,
    rate: 1,
    cutoff: 20000,
  }, { fade: 0.1 });
  voice.update({ gain: 0.25, pan: 1, rate: 1, cutoff: 20000 }, 0.1, 0.3);
  voice.stop(0.1, 0.6);
  const rendered = await context.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);
  const near = (actual: number, expected: number) => {
    if (Math.abs(actual - expected) > 0.003) {
      throw new Error(`Audio level ${actual} != ${expected}`);
    }
  };
  near(left[12000], 0);
  near(right[2400], 0.25);
  near(right[12000], 0.5);
  near(right[16800], 0.375);
  near(right[24000], 0.25);
  near(right[31200], 0.125);
  near(right[38400], 0);
  voice.dispose();
  const filtered = new OfflineAudioContext(2, 12000, 48000);
  const tone = filtered.createBuffer(1, 12000, 48000);
  const wave = tone.getChannelData(0);
  for (let i = 0; i < wave.length; i++) {
    wave[i] = Math.sin(i / 48000 * Math.PI * 2 * 8000);
  }
  play(filtered, tone, { gain: 1, pan: -1, rate: 1, cutoff: 500 });
  play(filtered, tone, { gain: 1, pan: 1, rate: 1, cutoff: 20000 });
  const toneResult = await filtered.startRendering();
  const energy = (channel: number) =>
    toneResult.getChannelData(channel).slice(1000).reduce(
      (sum, value) => sum + value * value,
      0,
    );
  if (energy(0) >= energy(1) * 0.01) {
    throw new Error("Occlusion lowpass did not suppress high-frequency energy");
  }
  return {
    left: left[12000],
    peak: right[12000],
    faded: right[31200],
    stopped: right[38400],
  };
}
Object.assign(globalThis, {
  inkReady: true,
  witnesses: {
    testInput,
    testPreferences,
    testNavigation,
    testAudio,
    testLifetimes,
    selected: () => selected,
    inventory: () => inventory,
    scale: () => scale,
    dispose: () => {
      popup.dispose();
      modal.dispose();
      controls.dispose();
      inventoryControl.dispose();
      scaleControl.dispose();
    },
  },
});

/** Audit actual native listeners and audio graph edges, including abort removal. */
async function testLifetimes() {
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  const originalConnect = AudioNode.prototype.connect;
  const originalDisconnect = AudioNode.prototype.disconnect;
  const listeners: {
    target: EventTarget;
    type: string;
    listener: unknown;
    capture: boolean;
  }[] = [];
  const connections = new Set<AudioNode>();
  let peakListeners = 0;
  let peakConnections = 0;
  let callbacks = 0;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    let capture = false;
    if (typeof options === "boolean") capture = options;
    else capture = options?.capture ?? false;
    const entry = { target: this, type, listener, capture };
    if (
      listener &&
      !listeners.some((item) =>
        item.target === this && item.type === type &&
        item.listener === listener && item.capture === capture
      )
    ) {
      listeners.push(entry);
      if (typeof options === "object" && options.signal) {
        originalAdd.call(options.signal, "abort", () => {
          const index = listeners.indexOf(entry);
          if (index >= 0) listeners.splice(index, 1);
        }, { once: true });
      }
    }
    peakListeners = Math.max(peakListeners, listeners.length);
    originalAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (
    type,
    listener,
    options,
  ) {
    let capture = false;
    if (typeof options === "boolean") capture = options;
    else capture = options?.capture ?? false;
    const index = listeners.findIndex((item) =>
      item.target === this && item.type === type &&
      item.listener === listener && item.capture === capture
    );
    if (index >= 0) listeners.splice(index, 1);
    originalRemove.call(this, type, listener, options);
  };
  AudioNode.prototype.connect = function (...args: unknown[]) {
    const result = Reflect.apply(originalConnect, this, args);
    connections.add(this);
    peakConnections = Math.max(peakConnections, connections.size);
    return result;
  };
  AudioNode.prototype.disconnect = function (...args: unknown[]) {
    const result = Reflect.apply(originalDisconnect, this, args);
    connections.delete(this);
    return result;
  };
  const context = new OfflineAudioContext(1, 128, 48000);
  const sources: AudioBufferSourceNode[] = [];
  const createSource = context.createBufferSource.bind(context);
  context.createBufferSource = () => {
    const source = createSource();
    sources.push(source);
    return source;
  };
  const buffer = context.createBuffer(1, 128, 48000);
  const mix = { gain: 1, pan: 0, rate: 1, cutoff: 1000 };
  let cycles = 0;
  try {
    for (; cycles < 100; cycles++) {
      const fixture = document.createElement("div");
      fixture.tabIndex = 0;
      fixture.innerHTML =
        `<dialog aria-label="Audit dialog"><button>Close</button></dialog><button>Menu</button><div id="audit-menu-${cycles}" aria-label="Audit menu"><button>Choice</button></div><select aria-label="Audit list"><option>A</option><option>B</option></select><input aria-label="Audit slider"><output></output>`;
      document.body.append(fixture);
      const modal = dialog(fixture.querySelector("dialog")!);
      const trigger = fixture.querySelector("button")!;
      // The trigger belongs outside the modal so disposal also restores native focus.
      const menuTrigger = fixture.children[1] as HTMLButtonElement;
      const popup = menu(
        fixture.children[2] as HTMLElement,
        menuTrigger,
        () => callbacks++,
      );
      const select = fixture.querySelector("select")!;
      const range = fixture.querySelector("input")!;
      const list = listbox(select, () => callbacks++);
      const slide = slider(range, () => callbacks++);
      const controls = input(fixture, {
        audit: { accept: [{ device: "keyboard", code: "KeyQ" }] },
      }, "audit");
      const caption = subtitles(fixture.querySelector("output")!);
      fixture.focus();
      modal.open();
      modal.dispose();
      popup.open();
      fixture.children[2].querySelector("button")!.click();
      select.dispatchEvent(new Event("change"));
      range.dispatchEvent(new Event("input"));
      equal(callbacks, (cycles + 1) * 3);
      applyPreferences(fixture, systemPreferences(window));
      caption.show({ text: "Audit" });
      const voice = play(context, buffer, mix, { loop: true });
      equal(connections.size, 4);
      voice.dispose();
      voice.dispose();
      popup.dispose();
      list.dispose();
      slide.dispose();
      controls.dispose();
      caption.dispose();
      equal(fixture.querySelector("output")!.textContent, "");
      trigger.click();
      menuTrigger.click();
      select.dispatchEvent(new Event("change"));
      range.dispatchEvent(new Event("input"));
      fixture.dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyQ", bubbles: true }),
      );
      equal(controls.sample().actions.accept.down, false);
      equal(callbacks, (cycles + 1) * 3);
      equal([listeners.length, connections.size], [0, 0]);
      equal(sources.every((source) => source.buffer === null), true);
      fixture.remove();
    }
    // Invalid cross-context destinations must disconnect a partially built graph.
    const other = new OfflineAudioContext(1, 128, 48000);
    let rejected = false;
    try {
      play(context, buffer, mix, { destination: other.destination });
    } catch {
      rejected = true;
    }
    equal(rejected, true);
    equal([listeners.length, connections.size], [0, 0]);
    equal(sources.every((source) => source.buffer === null), true);
    const rendered = await context.startRendering();
    equal(rendered.getChannelData(0).every((value) => value === 0), true);
    return {
      cycles,
      peakListeners,
      peakConnections,
      remainingListeners: listeners.length,
      remainingConnections: connections.size,
      retainedBuffers: sources.filter((source) =>
        source.buffer !== null
      ).length,
      callbacks,
    };
  } finally {
    EventTarget.prototype.addEventListener = originalAdd;
    EventTarget.prototype.removeEventListener = originalRemove;
    AudioNode.prototype.connect = originalConnect;
    AudioNode.prototype.disconnect = originalDisconnect;
  }
}
