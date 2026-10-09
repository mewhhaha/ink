# Building an editor from blocks

An Ink editor is a React tree inside `<InkApp>`. Everything in it reads and
changes one `Session`; nothing is special-cased for "the editor". These are the
pieces you will reach for most, from small to large.

## Layout

```tsx
<InkApp
  project="examples/mygame"
  title="My Game"
  presets={presets}
  hud={<Hud />}
>
  <TopBar>
    <Brand subtitle="level editor" />
    <SaveButton />
    <HistoryButtons />
    <Spacer />
    <ToolPicker tools={myTools} />
    <SnapControls />
    <PlayControls />
    <Spacer />
    <BuildStatus />
    <FrameProfiler />
    <CollaborateButtons />
    <LayoutButton />
  </TopBar>
  <Workspace>
    <Split id="columns">
      <Pane size={260}>
        <Panel title="Scene">
          <Outliner presets={presets} />
        </Panel>
      </Pane>
      <Pane>
        <Viewport id="main" tools={myTools} diagnostics />
      </Pane>
      <Pane size={320}>
        <Panel title="Inspector">
          <Inspector />
        </Panel>
      </Pane>
    </Split>
  </Workspace>
</InkApp>;
```

`FrameProfiler` is a toolbar readout of the game step, drawing and GPU time and
the last save-to-pixels time; click it for every metric and the stages of the
latest code, schema, scene and tuning changes (`docs/iteration.md`). Read the
same numbers with `session.profiler.snapshot()`.

`Split` panes remember their sizes; `Panel` takes `tabs`. `Viewport` takes
`view="perspective" | "top" | "front" | "side" | "game"`. Ctrl+G flips the whole
app to the game alone and back.

## Reading and changing the world

```tsx
function Health({ id }: { id: number }) {
  const session = useSession();
  const health = useComponent(id, "health") as
    | { value: number; max: number }
    | undefined;
  if (!health) return null;
  return (
    <button
      onClick={() =>
        session.edit("Heal", (world) => {
          const e = world.entities.find((e) => e.id === id)!;
          e.components.health.value = health.max;
        })}
    >
      {health.value} / {health.max} — heal
    </button>
  );
}
```

- `useWorld()`, `useEntity(id)`, `useComponent(id, name)`, `useResource(name)`,
  `useSelection()`, `useMode()` subscribe with fine-grained equality, so a 60 Hz
  game only re-renders what changed.
- Above 1,024 entities, `world.entities` holds lazy entities: reading
  `entity.components` decodes that entity's components, and
  `cloneEntity(entity)` (not a spread or `structuredClone`) copies one.
  Selectors should not do it for every entity on every step. Use
  `session.structure` (ids, parents and names; the same object until one
  changes), `session.entity(id)`, and `hasComponent(entity, "camera")` /
  `componentOf(entity, "camera")`, which read the packet without decoding the
  rest.
- `session.edit(label, recipe)` is one undo step. For drags and sliders use
  `const tx = session.begin(label); tx.update(recipe) ...; tx.commit()`.
- Edits go to the scene in edit mode and to the live world while playing.
- `session.createEntity({ name, parent, components })` accepts scene-style
  components: asset paths like `"builtin:cube"`, missing fields defaulted.

## A HUD is a panel too

```tsx
function Hud() {
  const score = useResource("score") as { value: number } | undefined;
  return (
    <div style={{ position: "absolute", left: 12, bottom: 12 }}>
      {score?.value}
    </div>
  );
}
// <Viewport id="game" view="game"><Hud /></Viewport>, and <InkApp hud={<Hud />}>
```

UI buttons that affect the game should go through input so they are recorded and
replayable: declare `restart: button()` in the schema's actions and call
`session.input.press("restart")`.

## Viewport tools

A tool gets pointer events in editor views when `ui.tool` is its id, and can
draw overlay lines every frame.

```ts
const stamp: ViewportTool = {
  id: "stamp",
  label: "Stamp trees",
  icon: "sparkle",
  shortcut: "T",
  noGizmo: true,
  pointerDown(ctx, e) {
    const at = ctx.planePoint(e.x, e.y);
    if (!at) return false;
    ctx.session.createEntity({
      name: "Tree",
      components: {
        transform: { position: ctx.snap(at) },
        mesh: { shape: "models/tree.glb" },
      },
    });
    return true;
  },
  overlay(ctx) {
    return []; // Line[] in world space: { from, to, color, width?, depthTest? }
  },
};
// <InkApp tools={[stamp]}> for hotkeys and the palette, <Viewport tools={[stamp]}> to use it.
```

`ViewportContext` has `ray(x, y)`, `pick(x, y)` (entity, brush face, point,
normal), `project(point)`, `planePoint(x, y)`, `snap(point)`, `pixel(point)`,
the camera, the scene and the UI state. `@ink/brushes` is a larger example of
tools built this way; `@ink/tiles` provides paint, erase, rectangle, fill and
picker tools for tile maps (see `docs/2d.md`). A viewport can `hideEntity` (a
game's HUD in a level view) and `frameOnOpen`.

## Commands

```ts
const commands: Command[] = [{
  id: "drop-to-floor",
  label: "Drop selection to the floor",
  shortcut: "End",
  run: ({ session }) => session.edit("Drop to floor", (world) => {/* ... */}),
}];
// <InkApp commands={commands}>
```

Commands get hotkeys and show in the palette (Ctrl+K), which also offers
contextual actions: add a component the selection lacks, jump to an entity,
create from a preset, open a scene.

## Lower levels

- `@ink/core`'s `Session` works without React: tests and the CLI use it.
- `@ink/render` draws a `RenderScene` (from `extractScene(world, catalog)`) into
  any canvas or offscreen size; `view.pick` and `view.capture` work on the last
  frame.
- `@ink/schema` turns worlds into packets and scene files and back.
