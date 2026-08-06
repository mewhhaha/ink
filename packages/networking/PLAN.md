# @ink/networking plan

Status: implemented and verified.

## Purpose

Support authoritative multiplayer sessions with explicit transport, replication,
prediction, interpolation, reconciliation, and optional rollback without making
one game-state model mandatory.

## Ownership

This package owns connection and session state, channels, packet framing,
handshake and compatibility, schema-driven replication, interest, baselines,
snapshots, input transport, interpolation, client prediction, reconciliation,
rollback coordination, time synchronization, loss handling, and network
diagnostics. It does not own accounts, matchmaking, commerce, game rules, server
deployment, encryption primitives, or ECS authority.

## Planned contracts

- Browser/client and server transport interfaces. WebTransport exposes the
  channel classes it supports. WebSocket exposes reliable ordered delivery;
  logical channels retain head-of-line blocking, and capability negotiation
  reports unsupported guarantees rather than silently emulating them.
- Versioned handshake carrying protocol, engine, game artifact, schema, feature,
  and content digests.
- Stable network identities and declared replicated schemas with quantization,
  authority, frequency, relevance, and change extraction.
- Authoritative snapshots, acknowledged baselines, input commands, predicted
  frames, interpolation samples, corrections, and rollback requests.
- Transport simulator for latency, jitter, loss, duplication, corruption,
  bandwidth, and reordering.

## Dependencies and integration

Direct dependencies: `@ink/runtime` and `@ink/observability`.

Runtime supplies deterministic frame and snapshot boundaries. Games supply
authority, interest, and replicated schemas. Specialized editors or applications
own ECS, scene, physics, and input adapters under the root adapter rule;
networking does not expose those identities in its primary contract. All
replication algorithms and codecs are Ink-owned.

## Tasks

- [x] **NET-001:** Define channel semantics, framing, handshake compatibility,
      limits, disconnect reasons, sequence arithmetic, and security boundaries.
- [x] **NET-002:** Implement first-party packet codecs, fragmentation,
      reassembly, acknowledgements, retransmission where needed, keepalive,
      congestion observations, and bounded queues.
- [x] **NET-003:** Implement secure WebSocket and WebTransport adapters with
      truthful channel capabilities, explicit fallback, and untrusted payload
      parsing at the transport boundary.
- [x] **NET-004:** Implement schema-driven snapshots, quantization, change
      extraction, acknowledged baselines, interest filtering, identity
      lifecycle, and bandwidth budgets.
- [x] **NET-005:** Implement time synchronization, snapshot interpolation,
      normalized input commands, client prediction, authoritative correction,
      and configurable reconciliation.
- [x] **NET-006:** Implement rollback coordination using runtime snapshots and
      deterministic resimulation without requiring every game to enable it.
- [x] **NET-007:** Define data-only replication, transform, physics, and input
      ports plus conformance fixtures; application composition owns adapters to
      concrete subsystem state.
- [x] **NET-008:** Add handshake mismatch, wraparound, loss, duplication,
      reordering, fragmentation, stale baseline, identity reuse, correction,
      rollback, reconnect, malformed packet, and queue-limit tests.
- [x] **NET-009:** Benchmark encoding, snapshot size, bandwidth, queue growth,
      interpolation delay, correction magnitude, and resimulation cost.

## Operational requirements

- Every packet and handshake is untrusted, length-bounded, and parsed before
  allocation into trusted state. Protocol, schema, digest, sequence, and
  authority failures return explicit disconnect or rejection reasons.
- Transport capability loss reports the unavailable guarantee or closes the
  session according to declared policy; it never silently changes authority or
  delivery semantics.
- Connection state, RTT, jitter, loss, queues, bandwidth, baselines,
  corrections, rollback work, malformed input, and disconnect reasons emit
  bounded redacted observations.
- Packet codecs, sequence handling, replication selection, prediction, and
  impairment simulation are deterministic for the same build and inputs; network
  arrival time is not.

## Acceptance

The authoritative state always wins, and predicted state converges without
mutating confirmed history. Unknown, malformed, oversized, incompatible, or
stale packets are rejected with a bounded diagnostic and cannot allocate
unbounded memory. The simulator reproduces a configured impairment run from its
seed, and rollback reproduces the corrected same-build snapshot checksum.
