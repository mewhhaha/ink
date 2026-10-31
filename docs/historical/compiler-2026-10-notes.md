# Historical compiler measurements, October 2026

These observations describe compiler versions used before the named-owner
migration. Timing ratios, inline limits, copy decisions and source idioms below
are historical evidence, not current language or library contracts. Some names
and syntax were subsequently retired. Use [the current guide](../blot.md) for
new code and the linked audit artifacts for exact source/compiler identities.

- The `Vec3`s, `Quat`s, other nominal records and `Maybe`s a hot path builds,
  operator temporaries such as `(a + b) * 0.5` included, are heap allocations
  unless they stay in an inlined call's locals (next note); each that crosses a
  call costs on the order of 0.1 to 0.2 µs. `std/vector` operators and helpers
  built on them, such as `math.Quat.rotate` outside loops, cost about a
  microsecond a call. The same operations on scalar fields, in the operators'
  order, round identically without the allocations: spline, steering, rig, orbit
  and director kernels gained 1.2 to 10 times that way, `ui/bubbles` rotations
  cost a fifth as much, and the scene, spatial, camera, view and gizmo paths
  work the same way.
- A record built in locals is boxed whenever it is passed to, or returned from,
  a call that is not inlined. Returned from such a call, a `Vec3`, `Quat` or
  other nominal record costs two allocations and a tuple or flat structural
  record one: `math.rotate_parts` returns a tuple, about 50 ns a call where its
  `Vec3` form took 110 to 160 ns. Outside loops only bodies of at most four
  nodes inline. Inside loops a function with a record or tuple result inlines up
  to 64 nodes, six levels deep, until the emitting function reaches 4,096
  instructions. Scalar results keep the four-node limit, so
  `vector.Vec3.dot a b` or `.length` boxes a local vector: write the arithmetic
  out or pass scalar parts. Destructured fields cost one node each, half a
  projection. Inlined locals still expand to many instructions, so large kernels
  use up the 4,096-instruction budget; keep big kernels out of line.
- An inlined result stays in locals only when every path builds a fresh record:
  a module constant such as `math.identity_quat`, or another call's result, on
  any path boxes it, so rebuild it from its fields.
- A loop-carried record whose first value was unwrapped from a variant, such as
  `let #Some timer = time.timer 1.0`, stays boxed, so every iteration allocates
  its replacement. Rebuild the first value from its fields before the loop.
- `&&` and `||` take a deferred right operand, which keeps their function from
  inlining; small kernels nest `if`s instead, which took `tween.make` from about
  0.5 µs a call to 8 ns. The same rewrite elsewhere measured no change, so
  measure before converting conditions.
- Receiver calls with arguments, such as `a.dot b` or `u.cross v`, build a bound
  closure; call `vector.Vec3.cross a b` in hot code.
- Each `record.field := value` rebuilds the whole record. Build wide records
  such as `ui/tree.Node` or `input.Input` in one constructor rather than a chain
  of updates.
- Explicit `std/simd` lanes pay where four independent lanes share the work: the
  spline arc table measures four samples per vector (23% faster), and Perlin
  noise mixes its eight corner hashes as two `U32x4`s (15%). Keeping the scalar
  operation order lane for lane keeps results bit-identical. Packing single
  values into lanes loses: one quaternion product, Perlin's gradient choice (an
  exact `% 12` per lane costs more than eight scalar calls), and frustum
  culling's six planes (2%, not kept). Lane values cross direct calls to private
  functions unboxed, yet such helpers measured about 5% slower than the same
  arithmetic inline in the spline and noise kernels. Calls through a closure box
  once per call, and a pipeline into a partial application
  (`lanes |> simd.u32_shl 13`) builds a closure each time: write
  `simd.u32_shl 13 lanes` in hot code.
- Transparent `type Name = ...` aliases work across modules. The current
  compiler packs flat scalar records/products and qualifying nested numeric
  records, including public closed single-constructor nominal records, with up
  to 16 scalar leaves. Reference-bearing fields and multiple-constructor types
  keep ordinary storage. Numeric array lanes are four bytes, and a packed row
  uses one lane per leaf. Earlier pins only packed flat structural rows.
  Packed storage does not guarantee allocation-free access: extracting a nested
  row or crossing an uninlined helper can reconstruct its boxed object graph.
  The working-set benchmarks retain a nested/flat comparison for this boundary.
- A `for` over a List of packed rows (flat tuples or structural records) retains
  about a kilobyte per traversal until the guest call returns; scalar Lists and
  Arrays of packed rows do not. Scan an Array or a flat buffer instead.
  `shapes.hull_poly` keeps its corners in a flat buffer for this reason.
- Appending or prepending boxed values one at a time to a List is quadratic:
  arrays, nominal records (even a two-field one or `Vec3`) and records holding
  them. 16,384 appends take about 14 times as long as 4,096; scalars and flat
  structural tuples stay linear. Early exits can also defeat reuse of a growing
  list in the same function; bind values before appending one item at a time. In
  hot collectors, count, then fill an exactly sized array (`scene.build`,
  `debug`). Spatial queries walk depth first with a private stack and `break`
  when it empties. Animation events use two passes to preserve F32 boundary
  behaviour and chronological ordering.
- Earlier compiler measurements found superlinear collection of reference-bearing
  elements through array comprehensions. The 2026-10-25 native audit did not
  reproduce that for `#[#[i, i + 1] | i <- indices]`: both comprehension and
  `array.generate` scaled approximately linearly through 4,096 rows, with the
  same committed memory and destroyed-object count. This does not qualify every
  filtered/capturing form. Measure the actual collector before replacing clear
  comprehensions with count/fill loops (`text.words`, `menu.sprites`).
- Rebinding array elements is cheap when a fresh local array stays inside its
  function. Passing it to a function that only reads it (lengths, indexing,
  `for`, `simd.load`, or handing it to another such reader) keeps later writes
  in place. A callee that returns, stores or captures it makes them copy, and so
  do a generic callee whose parameter is not annotated `Array T` and a callee
  containing `match`. Retained swap aliases can also defeat reuse. The sorters
  avoid excessive copying with fresh pass buffers and exact loop bounds.
- In the 2026-10-26 point-grid probe, assigning nominal `Point` records into a
  fresh array still produced `copy_required: nonexclusive_predecessor` on
  compiler SHA-256 `af349b1e6f391f7b`. Constructing each whole record directly did
  not remove it. Building scalar chain links first, then generating the record
  array once, reduced the 16,384-point construction/output fixture from 86.017
  to 8.963 ms with identical output. Ink now uses that construction. This is
  not a general rule that nominal arrays require copying. The collection review
  retains source, allocation decisions and samples for a compiler ownership
  reduction.
- `break` in an array-writing loop no longer disables reuse on the pinned
  compiler; the native compiler-probe checks keeps an intentional break control beside
  increasing writes, pathfinding and U32 sorting, with numerical checksums
  beside the timings.
- Writing one local array under both arms of an `if`/`else` or
  `if let ... else:`, whether the branch sits in a loop or each arm runs its own
  loop, loses the in-place write path: every write copies the whole array, about
  25 times the cost of an in-place write, which makes the loop quadratic. Writes
  in only one arm, or one unconditional write per iteration, stay in place.
  Choose the value in the branches and write it once after them, or choose the
  pass with loop bounds so the unused loop runs zero times (`spatial.refit`).
- Rebinding a loop-carried array to a freshly grown copy, whether inside a
  branch or once per outer pass, makes every later indexed write in the loop
  copy the whole array (navigation's heap stays allocated at its full size).
- A closure literal passed straight to `@array.generate`, or to a reading
  parameter such as `std/array.map`, borrows the arrays it only reads, so later
  writes stay in place. A closure bound to a local first (`let f = func ...`), or
  one that stays alive, makes every later in-place write copy the captured
  array, which turns a write loop quadratic: pass the literal.
- Curried calls can capture mutable array lookups and make later writes copy
  storage. Bind lookup results to scalar locals before passing them to calls or
  compound comparisons; this removed two hot memory copies from pathfinding.
- A copy made with `@array.slice` is not known to be fresh: later writes copy it
  again each time (a 65536-element write loop went from 0.3 ms to 366 ms).
  `arrays.copy` uses `@array.generate` for that reason.
- Returning a data value such as `#Nothing` from inside a `for` loop that also
  rebinds a carried local slows every iteration about four times, even when the
  return never fires (a scalar return or no carried local stays fast). Set a
  flag, `break`, and return after the loop, as `navigation.grid` does.
- Reading an ECS column with `values.get(index)` inside an `array.generate`
  callback made reads scale with the column: cycle-collector work grew about
  twentyfold per doubling. A bounds check and `values[index]` fixed it. Small
  fixtures outside the ECS's nested effect scopes stay linear, so measure.
- Trial-deletion cycle collection can visit a large graph reachable from its
  candidates. Historical pins used a fixed 64 KiB traffic threshold; the local
  Blot source reviewed on 2026-10-25 has an adaptive threshold and exact
  immutable-acyclic proofs that skip collection. Source capabilities do not
  establish which paths the installed binary optimizes. Copying shared reference
  arrays can still amplify both reference-count and collector work. The guest's
  `blot:rc_*` and `blot:cycle_*` counters distinguish these costs.

The [2026-10-25 audit](../tools/audits/2026-10-25-whole-library.json) records
compiler hashes and executable probes for these compiler-dependent notes;
historical timing ratios and inline-budget details above are not language
contracts. With 4,096 scalar writes, a slice-then-write loop took 0.829 ms versus
0.020 ms for generate-then-write, and writes in both conditional arms took
0.793 ms versus 0.010 ms for one write of a conditional value. Their counters
show thousands of destroyed objects versus single digits, with no cycle passes.
These are ownership/freshness optimization gaps, not SIMD or collector costs.
Separately, the complete profile-packet decoder showed quadratic reference-count
traffic. Validating/indexing first and constructing reference-bearing rows
afterward reduced 2,048-node decoding from 41.744 ms to 0.667 ms. The prototype
preserves complete-packet validation in differential tests; partial-tail recovery
is a separate contract. Early-failure control flow is a compiler investigation
candidate, not a proven explanation of every allocation in that decoder.

The follow-up [ownership patch](../tools/experiments/blot-owned-arrays.patch)
teaches Blot that exact-array slice/concat results have fresh outer storage and
that two writes in provably disjoint branches consume one dynamic array
version. Lists, escaping aliases and retained predecessors keep the conservative
path. Native ownership tests, allocation-failure sweeps and executed-Wasm
snapshot regressions pass. The slice and branch probes become linear without
rewriting the caller. This is a development patch in `../blot2`, not an installed
compiler guarantee: full release qualification remains pending. Safe builds of
the unmodified parent revision also hit an entry-interface assertion on Ink's
codec fixture; Ink's full suite passes with the installed compiler. Exact
compiler identities and measurements are recorded in the
[implementation report](../tools/audits/2026-10-25-library-improvements.json).
