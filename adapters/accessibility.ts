export interface Preferences {
  reducedMotion: boolean;
  uiScale: number;
  subtitles: boolean;
  highContrast: boolean;
}

/** An explicit snapshot; persistence and overrides belong to the application. */
export function systemPreferences(window: Window): Preferences {
  return {
    reducedMotion:
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    highContrast:
      window.matchMedia("(prefers-contrast: more), (forced-colors: active)")
        .matches,
    uiScale: 1,
    subtitles: true,
  };
}

/** Styles consume these attributes and --ink-ui-scale; no global style injection. */
export function applyPreferences(
  root: HTMLElement,
  preferences: Preferences,
): void {
  if (
    !Number.isFinite(preferences.uiScale) || preferences.uiScale < 0.5 ||
    preferences.uiScale > 3
  ) {
    throw new RangeError("uiScale must be between 0.5 and 3");
  }
  root.toggleAttribute("data-reduced-motion", preferences.reducedMotion);
  root.toggleAttribute("data-high-contrast", preferences.highContrast);
  root.toggleAttribute("data-subtitles", preferences.subtitles);
  root.style.setProperty("--ink-ui-scale", String(preferences.uiScale));
}

export interface SubtitleCue {
  text: string;
  speaker?: string;
  direction?: string;
  kind?: string;
}

/** Include words for speaker, direction and sound kind instead of color alone. */
export function cueText(cue: SubtitleCue): string {
  const parts: string[] = [];
  if (cue.speaker) parts.push(`${cue.speaker}:`);
  if (cue.kind) parts.push(`[${cue.kind}]`);
  if (cue.direction) parts.push(`(${cue.direction})`);
  parts.push(cue.text);
  return parts.join(" ");
}

export interface Subtitles {
  show(cue: SubtitleCue | null, enabled?: boolean): void;
  dispose(): void;
}
export function subtitles(element: HTMLElement): Subtitles {
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  element.setAttribute("aria-atomic", "true");
  return {
    show(cue: SubtitleCue | null, enabled = true) {
      element.hidden = !enabled;
      element.textContent = "";
      if (cue && enabled) element.textContent = cueText(cue);
    },
    dispose() {
      element.textContent = "";
    },
  };
}
