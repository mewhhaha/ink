/** Context menus and dropdowns positioned at a point. */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.tsx";

export type MenuItem =
  | {
    label: string;
    icon?: string;
    shortcut?: string;
    disabled?: boolean;
    danger?: boolean;
    run(): void;
  }
  | { separator: true }
  | { heading: string };

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

const MenuContext = createContext<(menu: OpenMenu | null) => void>(() => {});

export function MenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  return (
    <MenuContext.Provider value={setMenu}>
      {children}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </MenuContext.Provider>
  );
}

/** Open a menu at the event's position: `onContextMenu={menu([...])}`. */
export function useMenu() {
  const open = useContext(MenuContext);
  return useCallback(
    (items: MenuItem[] | (() => MenuItem[])) =>
    (
      event: {
        clientX: number;
        clientY: number;
        preventDefault(): void;
        stopPropagation(): void;
      },
    ) => {
      event.preventDefault();
      event.stopPropagation();
      open({
        x: event.clientX,
        y: event.clientY,
        items: typeof items === "function" ? items() : items,
      });
    },
    [open],
  );
}

/** Open a menu under an element, e.g. a toolbar button. */
export function useDropdown() {
  const open = useContext(MenuContext);
  return useCallback((element: HTMLElement, items: MenuItem[]) => {
    const rect = element.getBoundingClientRect();
    open({ x: rect.left, y: rect.bottom + 4, items });
  }, [open]);
}

function Menu({ x, y, items, onClose }: OpenMenu & { onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const element = ref.current!;
    const rect = element.getBoundingClientRect();
    setPosition({
      x: Math.min(x, innerWidth - rect.width - 8),
      y: Math.min(y, innerHeight - rect.height - 8),
    });
    element.focus();
    const close = (event: Event) => {
      if (!element.contains(event.target as Node)) onClose();
    };
    addEventListener("pointerdown", close, true);
    addEventListener("blur", onClose);
    return () => {
      removeEventListener("pointerdown", close, true);
      removeEventListener("blur", onClose);
    };
  }, [x, y]);
  const actionable = items.flatMap((
    item,
    i,
  ) => ("run" in item && !item.disabled ? [i] : []));
  return createPortal(
    <div
      ref={ref}
      className="ink-menu ink-root-portal"
      style={{ left: position.x, top: position.y }}
      tabIndex={-1}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const at = actionable.indexOf(active);
          const next = e.key === "ArrowDown"
            ? actionable[(at + 1) % actionable.length]
            : actionable[(at - 1 + actionable.length) % actionable.length];
          setActive(next);
        }
        if (e.key === "Enter" && active >= 0) {
          const item = items[active];
          if ("run" in item) {
            onClose();
            item.run();
          }
        }
      }}
    >
      {items.map((item, i) => {
        if ("separator" in item) {
          return <div key={i} className="ink-menu-separator" />;
        }
        if ("heading" in item) {
          return <div key={i} className="ink-menu-label">{item.heading}</div>;
        }
        return (
          <button
            type="button"
            key={i}
            className="ink-menu-item"
            data-active={i === active}
            disabled={item.disabled}
            style={item.danger ? { color: "var(--ink-danger)" } : undefined}
            onPointerEnter={() => setActive(i)}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.icon
              ? <Icon name={item.icon} size={13} />
              : <span style={{ width: 13 }} />}
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.shortcut && <span className="ink-kbd">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>,
    document.querySelector(".ink-root") ?? document.body,
  );
}
