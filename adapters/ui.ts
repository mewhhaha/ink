/** Unstyled DOM controls. Callers own markup, labels, styling and disposal. */
export interface Disposable {
  dispose(): void;
}
export interface Dialog extends Disposable {
  open(): void;
  close(value?: string): void;
}
export interface Menu extends Disposable {
  open(last?: boolean): void;
  close(restore?: boolean): void;
}
export type Navigation =
  | "next"
  | "previous"
  | "up"
  | "down"
  | "left"
  | "right"
  | "activate"
  | "cancel";

/** Call with action edges from the caller's input loop. Native values and
 * events stay native; focus stays inside an active modal and skips inert UI. */
export function navigate(root: HTMLElement, action: Navigation): boolean {
  const document = root.ownerDocument;
  const active = document.activeElement;
  let modal = document.querySelector<HTMLDialogElement>("dialog:modal");
  if (active instanceof Element) {
    modal = active.closest<HTMLDialogElement>("dialog:modal") ?? modal;
  }
  if (modal && !root.contains(modal)) return false;
  const scope = modal ?? root;
  if (action === "cancel") {
    if (
      active instanceof HTMLElement && scope.contains(active) &&
      active.closest('[role="menu"]')
    ) {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      if (!active.dispatchEvent(event)) return true;
    }
    if (modal) {
      modal.close();
      return true;
    }
    return false;
  }
  if (action === "activate") {
    if (
      !(active instanceof HTMLElement) || !scope.contains(active) ||
      active.matches(":disabled, [aria-disabled=true]") ||
      active.closest("[inert]")
    ) return false;
    if (
      !active.matches(
        "button, a[href], input[type=checkbox], input[type=radio]",
      )
    ) return false;
    active.click();
    return true;
  }
  if (
    active instanceof HTMLInputElement && active.type === "range" &&
    scope.contains(active) && !active.disabled && action !== "next" &&
    action !== "previous"
  ) {
    const before = active.value;
    let direction = 1;
    if (action === "left" || action === "down") direction = -1;
    if (active.step === "any") {
      const minimum = Number(active.min || 0);
      const maximum = Number(active.max || 100);
      active.valueAsNumber = Math.max(
        minimum,
        Math.min(
          maximum,
          active.valueAsNumber + direction * (maximum - minimum) / 100,
        ),
      );
    } else if (direction > 0) active.stepUp();
    else active.stepDown();
    if (active.value === before) return false;
    active.dispatchEvent(new Event("input", { bubbles: true }));
    active.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (
    active instanceof HTMLSelectElement && scope.contains(active) &&
    !active.disabled && (action === "up" || action === "down")
  ) {
    const options = Array.from(active.options).filter((option) =>
      !option.disabled && !option.hidden &&
      !option.parentElement?.matches("optgroup:disabled")
    );
    let index = options.indexOf(active.options[active.selectedIndex]);
    if (action === "down") index++;
    else index--;
    const next = options[Math.max(0, Math.min(options.length - 1, index))];
    if (!next || next.selected) return false;
    active.selectedIndex = next.index;
    active.dispatchEvent(new Event("input", { bubbles: true }));
    active.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (
    active instanceof HTMLElement && scope.contains(active) &&
    active.closest('[role="menu"]') && (action === "up" || action === "down")
  ) {
    let key = "ArrowDown";
    if (action === "up") key = "ArrowUp";
    return !active.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  }
  const stops = Array.from(
    scope.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href], [tabindex]",
    ),
  ).filter((stop) =>
    stop.tabIndex >= 0 && !stop.matches(":disabled, [aria-disabled=true]") &&
    !stop.closest("[inert]") && stop.getClientRects().length > 0
  );
  if (!stops.length) return false;
  let direction = 1;
  if (action === "previous" || action === "up" || action === "left") {
    direction = -1;
  }
  let index = stops.indexOf(active as HTMLElement);
  if (index < 0) {
    index = -1;
    direction = 1;
  }
  stops[(index + direction + stops.length) % stops.length].focus();
  return true;
}
function requireName(element: HTMLElement) {
  if (
    !element.getAttribute("aria-label") &&
    !element.getAttribute("aria-labelledby")
  ) {
    throw new Error("Supply aria-label or aria-labelledby");
  }
}

export function dialog(element: HTMLDialogElement): Dialog {
  requireName(element);
  let previous: HTMLElement | null = null;
  const restore = () => {
    if (previous?.isConnected) previous.focus();
    previous = null;
  };
  element.addEventListener("close", restore);
  return {
    open() {
      if (element.open) return;
      const active = element.ownerDocument.activeElement;
      if (active instanceof HTMLElement) previous = active;
      element.showModal();
    },
    close(value = "") {
      element.close(value);
      restore();
    },
    dispose() {
      if (element.open) element.close();
      restore();
      element.removeEventListener("close", restore);
    },
  };
}

/** Buttons remain native; the popup implements menu keyboard navigation. */
export function menu(
  element: HTMLElement,
  trigger: HTMLButtonElement,
  select: (button: HTMLButtonElement) => void,
): Menu {
  requireName(element);
  if (!element.id) throw new Error("A menu needs an id");
  const events = new AbortController();
  const options = () =>
    Array.from(element.querySelectorAll<HTMLButtonElement>("button"));
  element.setAttribute("role", "menu");
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-controls", element.id);
  const focus = (index: number) => {
    const enabled = options().filter((option) => !option.disabled);
    if (!enabled.length) return;
    const next = enabled[(index + enabled.length) % enabled.length];
    for (const option of options()) option.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  };
  for (const option of options()) {
    option.type = "button";
    option.setAttribute("role", "menuitem");
    option.tabIndex = -1;
  }
  const close = (restore = true) => {
    element.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restore) trigger.focus();
  };
  const open = (last = false) => {
    element.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    let index = 0;
    if (last) index = options().filter((option) => !option.disabled).length - 1;
    focus(index);
  };
  close(false);
  trigger.addEventListener("click", () => {
    if (element.hidden) open();
    else close();
  }, { signal: events.signal });
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open(event.key === "ArrowUp");
    }
  }, { signal: events.signal });
  element.addEventListener("keydown", (event) => {
    const enabled = options().filter((option) => !option.disabled);
    const index = enabled.indexOf(
      element.ownerDocument.activeElement as HTMLButtonElement,
    );
    let next = index;
    if (event.key === "ArrowDown") next++;
    else if (event.key === "ArrowUp") next--;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = enabled.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    } else if (event.key === "Tab") {
      close();
      const modal = trigger.closest("dialog[open]");
      const scope = modal ?? element.ownerDocument;
      const stops = Array.from(scope.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href], [tabindex]",
      )).filter((stop) =>
        stop.tabIndex >= 0 && !stop.matches(":disabled") &&
        stop.getClientRects().length > 0
      );
      let next = stops.indexOf(trigger) + 1;
      if (event.shiftKey) next = stops.indexOf(trigger) - 1;
      if (modal) next = (next + stops.length) % stops.length;
      if (stops[next]) {
        event.preventDefault();
        stops[next].focus();
      }
      return;
    } else if (
      event.key.length === 1 && !event.ctrlKey && !event.metaKey &&
      !event.altKey
    ) {
      const ordered = [
        ...enabled.slice(index + 1),
        ...enabled.slice(0, index + 1),
      ];
      const match = ordered.find((option) =>
        option.textContent?.trim().toLocaleLowerCase().startsWith(
          event.key.toLocaleLowerCase(),
        )
      );
      if (match) next = enabled.indexOf(match);
      else return;
    } else return;
    event.preventDefault();
    focus(next);
  }, { signal: events.signal });
  element.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const option = target.closest("button");
    if (
      !(option instanceof HTMLButtonElement) || option.disabled ||
      !element.contains(option)
    ) return;
    close();
    select(option);
  }, { signal: events.signal });
  element.ownerDocument.addEventListener("pointerdown", (event) => {
    if (
      event.target instanceof Node && !element.contains(event.target) &&
      !trigger.contains(event.target)
    ) close(false);
  }, { signal: events.signal });
  element.ownerDocument.addEventListener("focusin", (event) => {
    if (
      !element.hidden && event.target instanceof Node &&
      !element.contains(event.target) && !trigger.contains(event.target)
    ) close(false);
  }, { signal: events.signal });
  return {
    open,
    close,
    dispose() {
      close(false);
      events.abort();
    },
  };
}

/** Native selects provide selection, typeahead and platform accessibility. */
export function listbox(
  element: HTMLSelectElement,
  change: (values: string[]) => void,
): Disposable {
  if (!element.labels?.length) requireName(element);
  element.size = Math.max(2, element.size);
  const listener = () =>
    change(Array.from(element.selectedOptions, (option) => option.value));
  element.addEventListener("change", listener);
  return {
    dispose() {
      element.removeEventListener("change", listener);
    },
  };
}

export function slider(
  element: HTMLInputElement,
  change: (value: number) => void,
): Disposable {
  if (!element.labels?.length) requireName(element);
  element.type = "range";
  const listener = () => change(element.valueAsNumber);
  element.addEventListener("input", listener);
  return {
    dispose() {
      element.removeEventListener("input", listener);
    },
  };
}
