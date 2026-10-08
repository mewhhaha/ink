import { createRoot } from "react-dom/client";
import "@ink/react/styles.css";
import { App } from "./app.tsx";

// First visit: frame the level in each view (the viewports persist their own
// cameras afterwards).
const cameras: Record<string, object> = {
  persp: {
    kind: "perspective",
    position: [14, 13, 10],
    yaw: 0.61,
    pitch: -0.49,
    distance: 28,
    fov: 60,
    size: 10,
  },
  top: {
    kind: "top",
    position: [0, 0, -10.5],
    yaw: 0,
    pitch: 0,
    distance: 0,
    fov: 60,
    size: 36,
  },
  front: {
    kind: "front",
    position: [0, 2, 0],
    yaw: 0,
    pitch: 0,
    distance: 0,
    fov: 60,
    size: 14,
  },
  side: {
    kind: "side",
    position: [0, 2, -10.5],
    yaw: 0,
    pitch: 0,
    distance: 0,
    fov: 60,
    size: 26,
  },
};
try {
  for (const [id, camera] of Object.entries(cameras)) {
    const key = `ink:camera:${location.pathname}:${id}`;
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, JSON.stringify(camera));
    }
  }
} catch {
  // storage blocked: the default cameras apply
}

createRoot(document.getElementById("root")!).render(<App />);
