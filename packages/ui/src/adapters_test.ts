import { assertEquals, assertThrows } from "@std/assert";
import {
  create_catalog,
  type MessageParameters,
} from "@ink/localization/catalog.ts";
import { Localizer } from "@ink/localization/localizer.ts";
import { BrowserUiAdapter } from "./browser.ts";
import { headless_ui_snapshot, serialize_headless_ui } from "./headless.ts";
import { layout_ui } from "./layout.ts";
import { require_ui_text } from "./localization.ts";
import {
  literal_text,
  type SemanticNode,
  ui_id,
  type UiSnapshot,
} from "./semantic.ts";
import { vec2 } from "@ink/math/vector.ts";

const resolver = {
  resolve: (
    message: string,
    parameters: MessageParameters,
  ) => message === "welcome" ? `Welcome, ${parameters.name}` : message,
};

function localized_snapshot(): UiSnapshot {
  const root: SemanticNode = {
    id: ui_id("root"),
    role: "region",
    label: { type: "message", id: "welcome", parameters: { name: "Player" } },
    layout: { type: "flex", direction: "column", gap: 0, padding: 0 },
    children: [
      {
        id: ui_id("play"),
        role: "button",
        label: literal_text("Play"),
        pressed: false,
      },
      {
        id: ui_id("secret"),
        role: "text_input",
        label: literal_text("Secret"),
        value: "hidden",
        private: true,
      },
      {
        id: ui_id("message"),
        role: "text_input",
        label: literal_text("Message"),
        value: "Hello",
        private: false,
        multiline: true,
      },
      {
        id: ui_id("status"),
        role: "status",
        label: literal_text("Ready"),
        politeness: "polite",
      },
    ],
  };
  return {
    revision: 1,
    direction: "rtl",
    root,
    announcements: [{
      id: ui_id("announcement.ready"),
      message: literal_text("Ready"),
      politeness: "polite",
    }],
  };
}

Deno.test("headless adapter exposes resolved semantics, state, actions, and direction", () => {
  const snapshot = localized_snapshot();
  const layout = layout_ui(snapshot, {
    viewport: vec2(200, 100),
    player_scale: 1,
    reduced_motion: false,
  });
  if (layout.type !== "ready") throw new Error(layout.reason);
  const headless = headless_ui_snapshot(snapshot, layout.entries, resolver);
  assertEquals(headless.direction, "rtl");
  assertEquals(headless.nodes[0].label, "Welcome, Player");
  assertEquals(
    headless.nodes.find((node) => node.id === "secret")?.state.value,
    "",
  );
  assertEquals(
    JSON.parse(serialize_headless_ui(headless)).announcements[0].message,
    "Ready",
  );
});

Deno.test("failed localization is evidence-bearing and cannot silently replace text", () => {
  assertThrows(
    () =>
      require_ui_text({ type: "message", id: "missing", parameters: {} }, {
        resolve: () => "",
      }),
    Error,
    'localization message "missing" failed: resolver returned empty text',
  );
});

Deno.test("UI text resolves through the shared localization catalog", () => {
  const localizer = new Localizer({
    locale: "en-GB",
    catalogs: [create_catalog({
      locale: "en",
      messages: {
        welcome: [{ type: "text", value: "Welcome, " }, {
          type: "parameter",
          name: "name",
        }],
      },
    })],
  });

  assertEquals(
    require_ui_text({
      type: "message",
      id: "welcome",
      parameters: { name: "Player" },
    }, localizer),
    "Welcome, Player",
  );
});

class FakeElement extends EventTarget {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  textContent = "";
  dir = "";
  value = "";
  checked = false;
  type = "";

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  remove(): void {}

  focus(): void {
    this.dispatchEvent(new Event("focus"));
  }
}

Deno.test("browser overlay remains semantic when HTML-in-canvas copy fails", () => {
  const root = new FakeElement("div");
  const events: unknown[] = [];
  const adapter = new BrowserUiAdapter({
    document: {
      createElement: (tag: string) => new FakeElement(tag),
    } as unknown as Document,
    root: root as unknown as HTMLElement,
    dispatch: (event) => events.push(event),
    texture_copy: { copy: () => false },
  });
  const snapshot = localized_snapshot();
  const layout = layout_ui(snapshot, {
    viewport: vec2(200, 100),
    player_scale: 1,
    reduced_motion: false,
  });
  if (layout.type !== "ready") throw new Error(layout.reason);
  adapter.update(snapshot, layout.entries, resolver);
  assertEquals(adapter.mode(), "overlay");
  const semantic_root = root.children[0];
  assertEquals(
    semantic_root.children.map((element) =>
      element.attributes.get("aria-label")
    ),
    [
      "Play",
      "Secret",
      "Message",
      "Ready",
    ],
  );
  assertEquals(semantic_root.attributes.get("aria-label"), "Welcome, Player");
  assertEquals(semantic_root.children[2].tagName, "TEXTAREA");
  semantic_root.children[0].focus();
  semantic_root.children[0].dispatchEvent(new Event("click"));
  assertEquals(events, [
    { type: "focus_changed", target: ui_id("play") },
    { type: "activated", target: ui_id("play") },
  ]);
});
