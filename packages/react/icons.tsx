/** Stroke icons on a 24-unit grid, drawn to sit on 12–16 px text. */
import type { SVGProps } from "react";

const paths: Record<string, string> = {
  play: "M7 4.5v15l12-7.5z",
  pause: "M8 5v14M16 5v14",
  stop: "M6.5 6.5h11v11h-11z",
  step: "M6 5l9 7-9 7zM18 5v14",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  save: "M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7",
  cube:
    "M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5zM12 12l8.5-4.75M12 12v9.5M12 12L3.5 7.25",
  camera: "M3 8h3l2-3h8l2 3h3v11H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  sun:
    "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  bulb: "M9 18h6M10 21h4M9 15c0-3-4-3-4-7a7 7 0 0 1 14 0c0 4-4 4-4 7z",
  spotlight: "M4 3h6v7H4zM7 10L2 21h20L10 7M12 13l3 6M8 13l-1 6",
  box: "M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10",
  move:
    "M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3",
  rotate: "M21 12a9 9 0 1 1-3-6.7M21 3v6h-6",
  scale: "M21 3l-7 7M21 3h-6M21 3v6M3 21l7-7M3 21h6M3 21v-6",
  select: "M5 3l14 8-6 2-3 6z",
  grid: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18",
  magnet: "M6 4v8a6 6 0 0 0 12 0V4M6 4h4v8a2 2 0 0 0 4 0V4h4M6 8h4M14 8h4",
  comment: "M4 5h16v11H9l-5 4z",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
  image:
    "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  eye:
    "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  copy: "M8 8h12v12H8zM16 8V4H4v12h4",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  folder: "M3 6h6l2 2h10v11H3z",
  file: "M6 2h8l4 4v16H6zM14 2v4h4",
  music:
    "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .5-1.5-1.5.5-2-3-1-1 2h-2l-1-2-3 1 .5 2L6.5 7.5 4.5 7l-1 3 2 1v2l-2 1 1 3 2-.5 1.5 1.5-.5 2 3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .5 1-3-2-1z",
  maximize: "M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6",
  minimize: "M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6",
  crosshair:
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM22 12h-4M6 12H2M12 6V2M12 22v-4",
  x: "M6 6l12 12M18 6L6 18",
  check: "M5 12l5 5 9-10",
  alert: "M12 3l10 18H2zM12 10v5M12 18v.5",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 11v6M12 7v.5",
  terminal: "M4 17l6-5-6-5M12 19h8",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  lock: "M6 10V7a6 6 0 0 1 12 0v3M4 10h16v12H4zM12 15v3",
  hand:
    "M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8l-1.5-2.5a2 2 0 0 0-3.4 2L5 20a5 5 0 0 0 4 2h5a6 6 0 0 0 6-6v-5a2 2 0 0 0-4 0",
  sparkle: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2zM19 3v4M17 5h4",
  dot: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  entity: "M12 3l9 5v8l-9 5-9-5V8z",
  link:
    "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  wand:
    "M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12.2 6.2l-1.4-1.4M3 21l9-9",
  clip: "M4 20L20 4M6 4h14v14",
  vertex:
    "M5 5h3v3H5zM16 5h3v3h-3zM5 16h3v3H5zM16 16h3v3h-3zM8 6.5h8M8 17.5h8M6.5 8v8M17.5 8v8",
  door: "M6 3h12v18H6zM14 12v.5",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
};

export type IconName = keyof typeof paths;

export function Icon(
  { name, size = 14, ...props }:
    & { name: IconName | string; size?: number }
    & SVGProps<SVGSVGElement>,
) {
  const filled = name === "play" || name === "dot";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name] ?? paths.dot} />
    </svg>
  );
}

/** Icon for a component, from its schema metadata or name. */
export function componentIcon(name: string, icon?: string): string {
  if (icon && icon in paths) return icon;
  return ({
    transform: "move",
    mesh: "cube",
    camera: "camera",
    light: "sun",
    brush: "box",
  } as Record<string, string>)[name] ??
    "entity";
}
