/**
 * Small stores shared by the tools and panels: which faces are selected, and
 * the defaults for new brushes. They are presentation state, never game state.
 */
import { Store, useStore } from "@ink/react";

export interface FaceRef {
  /** Entity id. */
  entity: number;
  /** Index into the entity's `brush.faces`. */
  face: number;
}

const sameRef = (a: FaceRef, b: FaceRef) =>
  a.entity === b.entity && a.face === b.face;

const faceStore: Store<{ faces: readonly FaceRef[] }> = new Store<
  { faces: readonly FaceRef[] }
>({ faces: [] });

/** The selected brush faces. Pass it to `<Viewport selectedFaces={faceSelection}>`
 * to highlight them. */
export interface FaceSelection {
  get(): readonly FaceRef[];
  subscribe(listener: () => void): () => void;
  set(faces: readonly FaceRef[]): void;
  add(faces: readonly FaceRef[]): void;
  toggle(faces: readonly FaceRef[]): void;
  clear(): void;
}

export const faceSelection: FaceSelection = {
  get: (): readonly FaceRef[] => faceStore.get().faces,
  subscribe: faceStore.subscribe,
  set(faces: readonly FaceRef[]) {
    faceStore.set({ faces });
  },
  /** Add faces that are not selected yet. */
  add(faces: readonly FaceRef[]) {
    const current = faceStore.get().faces;
    faceStore.set({
      faces: [
        ...current,
        ...faces.filter((f) => !current.some((c) => sameRef(c, f))),
      ],
    });
  },
  /** Select the faces that are not, deselect the ones that are. */
  toggle(faces: readonly FaceRef[]) {
    const current = faceStore.get().faces;
    const gone = (f: FaceRef) => faces.some((x) => sameRef(x, f));
    faceStore.set({
      faces: [
        ...current.filter((f) => !gone(f)),
        ...faces.filter((f) => !current.some((c) => sameRef(c, f))),
      ],
    });
  },
  clear() {
    if (faceStore.get().faces.length) faceStore.set({ faces: [] });
  },
};

export function useFaceSelection(): readonly FaceRef[] {
  return useStore(faceStore, (s) => s.faces);
}

export interface BrushDefaults {
  /** Texture path for new brushes ("" for none). */
  texture: string;
  /** Extent on each axis used for the dimension a drag does not define. It
   * follows the last brush drawn, so the other views stay consistent. */
  extent: [[number, number], [number, number], [number, number]];
}

export const brushDefaults: Store<BrushDefaults> = new Store<BrushDefaults>({
  texture: "",
  extent: [[-2, 2], [0, 3], [-2, 2]],
});

export function useBrushDefaults(): BrushDefaults {
  return useStore(brushDefaults, (s) => s);
}

/** State of the clip tool, for the toolbar hint. */
export interface ClipState {
  keep: "front" | "back" | "both";
  points: number;
}

export const clipState: Store<ClipState> = new Store<ClipState>({
  keep: "front",
  points: 0,
});
