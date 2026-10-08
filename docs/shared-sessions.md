# Shared editing

Every example editor has **Share scene** in its toolbar. Enter a display name
and join; other browsers opening the same scene can join that document. Up to
sixteen users can share one scene per project. The first connection seeds a new
shared document from its scene. Later connections receive the shared version.

Edits and comments save automatically. A colored outline marks another user's
selection. The sharing dialog lists people, selections and view poses. Selecting
an entity or moving an editor camera changes only that person's presentation.
Live HTTP/MCP edits use the same Session methods, so agents editing a connected
browser participate in the shared document.

Undo is personal. It reverses fields still owned by the local edit and preserves
newer changes by other authors. Continuous drags make one history item; cancel
restores the local fields while retaining remote changes. The visible History
panel uses this same history. Comments have their own stable reply identities,
so simultaneous replies survive.

To play together, open Feel Lab's `multiplayer` scene in both browsers before
sharing it. Edit the level, then join the same **Multiplayer** room. The game
starts from the shared scene using the rollback driver. Scene collaboration
continues to own the document; the play packet remains a separate simulation.
Switching editor/game layouts keeps both connections alive. See
`docs/multiplayer.md` for networking details.

## Data and persistence

`CrdtDocument` in `@ink/core` stores JSON field registers with Lamport clocks
and actor ids. Concurrent writes to one scalar field choose the greatest clock,
then actor id as a deterministic tie-breaker. Objects have explicit lifetimes:
deletion hides descendants while retaining their registers for undo. Numeric
vectors merge by axis. Other arrays, such as a brush's face list, are atomic
fields. Entity ordering uses per-entity ranks with an id tie-breaker. Cycles
created by concurrent reparenting are materialized with the lowest-id cycle edge
removed, preserving every entity.

`SharedSession` is a document driver for the existing Session. It diffs local
before/after snapshots into operations, groups gestures, manages conditional
undo, and applies remote snapshots without adding them to local history.
`Session.allocateEntity` obtains ids from disjoint reserved ranges; creation,
duplication, brush clipping and CSG use it. Range reservations persist before
the server issues them, so restarting cannot reuse an outstanding allocation.

The dev server stores clocks and tombstones in `.ink/shared/<scene>.json` and
materializes the ordinary scene file and `.ink/comments.json`. Each file is
replaced atomically; save acknowledgements arrive after all writes finish.
`flush()` waits for those acknowledgements. Source-file edits become operations
in the same document. Whole-file comment writes are refused while sharing, so an
unconnected browser cannot overwrite merged threads.

Presence is transient and separate from saved scene data. Losing the connection
keeps the local view and disables further shared scene mutations; leave to work
locally or rejoin the server's saved document. This development workflow has no
offline operation queue, accounts or access-control service. The server keeps
tombstones; it does not yet compact them through a coordinated garbage
collector.

## Verification

`deno task test:shared` drives two Chromium contexts through joining, concurrent
field edits, creation, replies, undo, camera movement, multiplayer, layout
switching and rejoining. It saves `tmp/shared-editing.png` and
`tmp/shared-play.png`. Unit tests cover reverse delivery, duplicates, deleted
objects, remote edits during a drag, hierarchy cycles, server restart, persisted
id allocations, spoofed actors and source edits.
