import { assertEquals, assertThrows } from "@std/assert";
import { asset_id, asset_ref } from "@ink/assets/identity.ts";
import {
  create_localized_asset,
  select_localized_asset,
} from "./experimental/assets.ts";
import { create_catalog } from "./catalog.ts";
import { Localizer } from "./localizer.ts";

Deno.test("localizer resolves language fallback with plural select and number formatting", () => {
  const english = create_catalog({
    locale: "en",
    messages: {
      summary: [
        {
          type: "select",
          name: "state",
          cases: {
            ready: [{ type: "text", value: "Ready: " }],
            other: [{ type: "text", value: "Waiting: " }],
          },
        },
        {
          type: "plural",
          name: "count",
          cases: {
            one: [{
              type: "parameter",
              name: "count",
              format: { type: "number" },
            }, { type: "text", value: " level" }],
            other: [{
              type: "parameter",
              name: "count",
              format: { type: "number" },
            }, { type: "text", value: " levels" }],
          },
        },
      ],
    },
  });
  const localizer = new Localizer({ catalogs: [english], locale: "en-GB" });

  assertEquals(
    localizer.resolve("summary", { state: "ready", count: 2 }),
    "Ready: 2 levels",
  );
  assertEquals(localizer.try_resolve("summary", { state: "ready", count: 1 }), {
    type: "resolved",
    value: "Ready: 1 level",
    locale: "en",
  });
});

Deno.test("localizer failures retain the message locale and missing argument", () => {
  const localizer = new Localizer({
    locale: "en",
    catalogs: [create_catalog({
      locale: "en",
      messages: { greeting: [{ type: "parameter", name: "player" }] },
    })],
  });

  assertThrows(
    () => localizer.resolve("greeting", {}),
    Error,
    'localization message "greeting" in en failed: message greeting requires argument "player"',
  );
});

Deno.test("catalog parsing snapshots formatter options and rejects invalid part kinds", () => {
  const options: Intl.NumberFormatOptions = { maximumFractionDigits: 0 };
  const catalog = create_catalog({
    locale: "en",
    messages: {
      count: [{
        type: "parameter",
        name: "count",
        format: { type: "number", options },
      }],
    },
  });
  options.style = "percent";
  assertEquals(
    new Localizer({ catalogs: [catalog], locale: "en" }).resolve("count", {
      count: 2,
    }),
    "2",
  );
  assertThrows(
    () =>
      create_catalog({
        locale: "en",
        messages: { broken: [{ type: "unknown" } as never] },
      }),
    Error,
    'type "unknown" is invalid',
  );
});

Deno.test("localized assets use language and configured fallback before the default", () => {
  const localized = create_localized_asset({
    default: asset_ref(asset_id("voice/default"), "audio"),
    variants: {
      fr: asset_ref(asset_id("voice/fr"), "audio"),
      pl: asset_ref(asset_id("voice/pl"), "audio"),
    },
  });

  assertEquals(select_localized_asset(localized, "fr-CA").asset.id, "voice/fr");
  assertEquals(select_localized_asset(localized, "de", ["pl-PL"]), {
    asset: asset_ref(asset_id("voice/pl"), "audio"),
    locale: "pl",
  });
});
