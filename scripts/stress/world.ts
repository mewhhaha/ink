/** Deterministic stress scenes: `count` entities, `movers` of them bodies. */
import type { SceneFile } from "@ink/schema";

export function stressScene(count: number, movers = count): SceneFile {
  let seed = 12345;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const entities: SceneFile["entities"] = [
    {
      id: 1,
      name: "Camera",
      components: {
        transform: { position: [0, 45, 90], rotation: [-0.2, 0, 0, 0.98] },
        camera: { fov: 60, far: 400 },
      },
    },
    {
      id: 2,
      name: "Sun",
      components: {
        transform: { rotation: [-0.5, 0.3, 0.1, 0.8] },
        light: { kind: "directional", intensity: 2 },
      },
    },
    { id: 3, name: "Sky", components: { environment: {} } },
  ];
  for (let i = 0; i < count; i++) {
    const components: Record<string, Record<string, unknown>> = {
      transform: {
        position: [(rand() - 0.5) * 100, rand() * 20, (rand() - 0.5) * 100],
        scale: [0.5, 0.5, 0.5],
      },
      mesh: {
        shape: i % 2 ? "builtin:cube" : "builtin:sphere",
        color: [rand(), rand(), rand(), 1],
      },
    };
    if (i < movers) {
      components.body = {
        velocity: [(rand() - 0.5) * 6, 0, (rand() - 0.5) * 6],
        spin: rand() * 4,
      };
    }
    entities.push({ id: i + 4, components });
  }
  return { ink: 1, seed: 12345, entities };
}
