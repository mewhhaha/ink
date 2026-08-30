# Vision: composing Ink from building blocks, done right

This document is a retrospective and a proposal. Ink attempted to build a game
engine as composable building blocks — thirty-plus packages, seven genre
editors, a Wasm guest boundary, and a host block graph. Much of what we built is
good. The way the blocks _compose_ is not yet good, and this document describes
what the APIs and interfaces should look like so that composition is the
strength of the system rather than its tax.

## What we attempted, and what held up

The load-bearing ideas of this project are correct and should survive any
redesign:

- **The Wasm boundary is the game boundary.** Game logic in a guest module, host
  capabilities granted explicitly, no ambient access. This is what makes
  save/load, replay, headless execution, and hot reload _properties of the
  architecture_ instead of features bolted onto each game.
- **Determinism as a contract.** Clocks, input, randomness, and scheduling are
  explicit effects; rendering is not deterministic state. Every good thing in
  this repo (replay, headless agents, snapshot-preserving hot reload) falls out
  of this one rule.
- **Accessibility is game output.** The semantic tree — real HTML elements with
  stable identities, reading order, and typed actions — is produced by the same
  state transition as pixels. Agents and screen readers consume the same
  vocabulary. This is rare and valuable; keep it.
- **Specialization lives outside core.** Genre editors compose libraries; core
  never learns what a "platformer" is. The dependency direction in AGENTS.md
  (core → editor → application) is right.

What did _not_ hold up is the machinery of composition itself. The following
sections name the failures precisely, because the better design is mostly the
negation of these failures.

## Where composition broke down

### 1. The type system exits at exactly the seam where composition happens

The runtime's composition contract (`packages/runtime/src/graph.ts`) is:

```ts
interface Block {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly capabilities: readonly string[];
  acquire(context: BlockAcquireContext): Awaitable<BlockInstance>;
}

interface BlockAcquireContext {
  readonly capabilities: ReadonlyMap<string, unknown>;
}
```

Everything upstream of this point is beautifully typed — fixed-point math, ECS
schemas, WGSL contracts. Then a block asks for `"clock"` by string and receives
`unknown`, and casts. Wiring errors (missing capability, wrong shape, typo'd id)
surface as runtime throws during `resolve_runtime_graph`, in tests if we're
lucky. The single most important join in the architecture — "this block needs
that capability" — is the only join the compiler cannot check.

### 2. Too many packages, too few consumers

We shipped 33 packages and 7 editors in one burst. Nearly every contract has
exactly one producer and one consumer, which means the package boundary verified
nothing: a seam earns its existence by being crossed from two sides with
different assumptions. Instead the boundaries multiplied surface area — every
package carries a PLAN.md, BENCHMARK.md, export map, and conformance fixtures —
while the composition they enable was never exercised by a second composer. The
breadth also forced the ownership rules ("a downstream package owns an adapter
when the dependency graph stays one-way") to live as prose in PLAN.md rather
than as anything a tool enforces.

### 3. Two composition planes with duplicated vocabulary

The host has a block graph (dependencies, capabilities, lifecycle phases). The
guest has the ECS (systems declaring component/resource reads and writes, folded
into a world at compile time). These are the _same idea_ — units of behavior
declaring typed accesses, composed by a scheduler that derives order from the
declarations — implemented twice with different vocabularies. The ECS version is
the better one: accesses are declared once, scopes are derived, read/write
intent is scheduling metadata, and invalid composition is rejected at build
time. The host version is the stringly-typed one described above.

### 4. The boundary vocabulary is maintained three times

The same conceptual contract — "what actions exist, what state is observable,
what crosses the boundary" — is hand-maintained as Blot effect imports, as the
TypeScript host adapter, and as the JSON Lines headless vocabulary. They are
kept in agreement by tests and discipline. Every addition to the ABI is a
three-site edit, which is why the semantic element vocabulary stayed frozen at
button/text/progress: growing it costs too much.

### 5. Lifecycle hooks conflate identity with scheduling

`BlockInstance` hardcodes the phase set (`initialize`, `start`, `fixed_step`,
`frame`, `close`). A block that wants two fixed-step systems with different data
dependencies, or work scheduled relative to _another block's_ work, has no way
to say so. Meanwhile the ECS already has the right model: named systems with
declared accesses, ordered by the scheduler. Blocks should produce systems; they
should not _be_ the schedule.

## The design: blocks as typed values, composition as a checked operation

The rest of this document is the proposal. One sentence version: **a block is a
value whose requirements and provisions are carried in its type, composition is
a function whose result type reflects what remains unmet, and the entire
boundary (host, guest, wire) is derived from one schema source.** Code sketches
use the repo's `snake_case` convention for Ink-owned functions.

### Capabilities are typed tokens, not strings

A capability is declared once, as a value that carries its interface type:

```ts
interface Clock {
  now_us(): bigint;
}

const clock = capability<Clock>("ink.clock");
const input = capability<InputSource>("ink.input");
const gpu = capability<GpuSurface>("ink.gpu.surface");
```

The string id still exists — it is the stable identity for observability,
serialization, and cross-language reference — but no consumer ever touches it.
Consumers hold the token, and the token's type parameter is the contract. There
is exactly one way to ask for a clock, and it is impossible to receive one as
`unknown`.

### Blocks declare needs and provisions in their type

```ts
const physics = block({
  id: "ink.physics",
  needs: [clock] as const,
  provides: [collision_events] as const,
  create({ clock }) {
    // clock: Clock — inferred from the token, no cast
    return {
      systems: [
        system(
          "integrate",
          { phase: fixed_step, writes: [bodies] },
          (dt) => {/* ... */},
        ),
      ],
      provide: { collision_events: make_collision_stream() },
    };
  },
});
// typeof physics: Block<needs: [Clock], provides: [CollisionEvents]>
```

Three things changed from the current `Block`:

1. `needs` is a tuple of tokens, and `create` receives a record typed by
   inference from that tuple. Miss a need, misuse a provision — compile error.
2. A block _provides_ capabilities as well as consuming them. The current design
   has separate `Capability` providers and `Block` consumers; in practice most
   blocks are both (physics consumes a clock and provides collision events). One
   kind of node, two typed edge lists.
3. The block returns **systems**, not lifecycle methods. Scheduling is the
   composer's job (next section).

### Composition is a function, and unmet needs survive in the result type

```ts
const world = compose(physics, render, semantic_ui, my_game);
// typeof world: Block<needs: [Clock, GpuSurface, InputSource], provides: [...]>

const app = provide(world, {
  clock: browser_clock(),
  gpu: webgpu_surface(canvas),
  input: dom_input(canvas),
});
// typeof app: Block<needs: [], provides: [...]>  — only now is it runnable

run(app); // run() accepts only Block<needs: []>
```

`compose` merges block sets: internal edges (one block's provision meeting
another's need) are satisfied and disappear from the type; unmet needs
accumulate. `provide` discharges needs with host implementations. `run` accepts
only a closed block. The property this buys is the whole point of the design:
**a mis-wired graph is not a program.** `resolve_runtime_graph`'s runtime
validation — duplicate ids, missing dependencies, dangling capabilities —
becomes the type of `compose`. The runtime check remains only for graphs
assembled dynamically (a loaded artifact), where it validates against the same
declarations rather than a parallel prose contract.

This is also what makes editors cheap, which was the original thesis of the
project (AGENTS.md): a specialized editor is a function from one composed block
to another — wrap it, add panels, replace a provision — and the compiler tells
the editor author exactly what their transformation still owes. The ECS slice
already proved this shape ("an editor is an ordinary function from one world
builder to another"); this design makes it true at every layer, not just inside
the ECS.

### One scheduling model, shared with the ECS

Blocks emit named systems with declared phase and data accesses — exactly the
shape `Ecs.system` already has. The scheduler is one piece of code that:

- derives execution order from reads/writes declarations, not from hook names;
- runs independent systems in any order (and can parallelize later without an
  API change, because intent is already data);
- rejects access conflicts at composition time, the way `Ecs.build` already
  rejects invalid worlds.

Host-side "block instances" and guest-side "ECS systems" stop being two theories
of behavior. The guest's ECS world is simply a block whose systems run in the
guest; the host's renderer is a block whose systems run in the host. Same
declarations, same scheduler semantics, same observability.

### The boundary is derived from schemas, written once

Every capability that crosses the Wasm boundary is declared as a schema, not as
a TypeScript interface, and everything else is generated from it:

```ts
const semantic_button = boundary_record("ink.semantic.button", {
  id: u32,
  label: text,
  description: opt(text),
  attached_to: opt(object_id),
  enabled: bool,
});

const activate = boundary_action("ink.semantic.activate", {
  target: u32,
});
```

From this single source we derive:

- the **TypeScript types** the host consumes (what today is hand-written in
  adapter code);
- the **guest imports** (Blot effect signatures, or another language's bindings
  — the language-neutrality of the boundary becomes real instead of
  aspirational, because a new toolchain implements generated signatures rather
  than reverse-engineering three hand-maintained vocabularies);
- the **JSON Lines vocabulary** for the headless host (today a parallel
  hand-kept protocol);
- the **schema digest** for hot reload compatibility (today computed, but from a
  different representation than the one documents are written against);
- the **snapshot codec** for save/load/replay.

The test for whether something belongs in the shared ABI stays exactly as
architecture.md states it — guest, protocol, adapter, headless observation, and
tests must all support it end to end — but the cost of passing that test drops
from five hand-written sites to one schema plus generated code, which is what
will actually let the semantic vocabulary grow past button/text/progress.

### Cross-cutting concerns are block transformers

Observability, snapshotting, replay, and hot reload are currently obligations
distributed across every block's implementation. They should be _wrappers_ —
functions from block to block — applied at composition:

```ts
const observed = with_observability(world, observer);
const durable = with_snapshot(observed); // codec derived from state schemas
const reloadable = with_hot_reload(durable, artifact_channel);
```

A transformer can see every system, every declared access, and every boundary
schema of the block it wraps, so it needs no cooperation from block authors:
`with_observability` times and reports each system by its stable id;
`with_snapshot` serializes exactly the declared state and nothing else;
`with_hot_reload` compares schema digests and decides restore-vs-reset. Block
authors write game and engine logic; the properties the project promises
(observable, reloadable, replayable) are supplied by the composition, which is
the only place they can be supplied _uniformly_.

## Package structure: consolidate until seams are earned

The 33-package layout should collapse to roughly six, with a hard rule for
re-extraction: **a package boundary requires two independent consumers with
different assumptions.** Until a second consumer exists, code lives in the most
specific place that uses it — exactly the AGENTS.md placement rule, applied to
packages themselves.

| Package         | Owns                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ink/core`     | Capability tokens, block algebra (`block`, `compose`, `provide`, `run`), scheduler, schema/boundary language, snapshot and digest derivation, observability transformer.              |
| `@ink/kernel`   | Deterministic foundations: fixed-point math, geometry, noise. No I/O, no platform types, usable from host and guest tooling alike.                                                    |
| `@ink/world`    | ECS, scene, and world state as blocks over `@ink/core`. The ECS keeps its current design — it is the best-composed thing in the repo.                                                 |
| `@ink/platform` | Browser capability providers: WebGPU surface and renderer, Web Audio, DOM input, HTML-in-Canvas semantic adapter, storage. Each provider discharges a core capability token.          |
| `@ink/blot`     | The Blot toolchain adapter: generated bindings from boundary schemas, artifact loading, build integration. Another language toolchain is a sibling of this package, not a fork of it. |
| `@ink/dev`      | Vite plugin, hot-reload transformer, headless JSONL host, editor UI primitives.                                                                                                       |

Rendering paths, materials, lighting, physics, navigation, animation, audio DSP,
networking — the current mid-tier packages — start as _modules inside_ these six
(mostly `@ink/platform` and `@ink/world`) and are extracted only when a second
composer needs them independently. Genre editors are applications, not packages:
they compose blocks and provide panels, and anything two editors genuinely share
graduates into `@ink/dev` by the two-consumer rule.

This is not a smaller ambition. It is the same ambition with the seams placed
where they are load-bearing, so each one is verified by real crossings instead
of by its own paperwork.

## What this preserves from today

- The Blot examples, the ECS design, fixed-point determinism, the semantic HTML
  surface, headless JSONL operation, and the hot-reload digest/restore/reset
  behavior all survive — most of them become _easier_ to state because their
  contracts move from prose into types and schemas.
- The dependency direction (core → editor → application) is unchanged; it
  finally becomes machine-checked, because an editor that reaches for a
  capability it didn't declare no longer typechecks.
- `snake_case` Ink-owned APIs, explicit effects at every boundary, and
  "degradable graphics, playable semantics" remain non-negotiable.

## The measure of success

One test subsumes the rest. Take the minimal game — one object, one button, one
transition — and require that its complete composition reads like this and
compiles with no casts, no string lookups, and no runtime wiring validation:

```ts
const game = compose(
  blot_guest(artifact), // needs: clock, input · provides: scene, semantics, actions
  scene_renderer(), // needs: gpu, scene
  semantic_html(), // needs: dom, semantics, actions
);

run(provide(with_snapshot(with_observability(game, observer)), {
  clock: browser_clock(),
  input: dom_input(canvas),
  gpu: webgpu_surface(canvas),
  dom: canvas_children(canvas),
}));
```

Then delete one line — the renderer, the provider, anything — and require that
the compiler, not a test suite and not a runtime throw, is what tells you the
composition is incomplete and exactly what it is missing. When both halves of
that test pass, the building blocks compose. Everything else in this document is
in service of that.
