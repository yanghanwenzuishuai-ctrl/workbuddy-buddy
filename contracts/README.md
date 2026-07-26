# Control Plane protocol contracts

This directory is the versioned Milestone 0 contract between a WorkBuddy Buddy
Edge and a future Control Plane.

## v1 files

- `openapi.json` — OpenAPI 3.1 paths, responses, headers, and SSE behavior.
- `schemas/edge-report-envelope.v1.schema.json` — strict state/heartbeat request
  envelope. The heartbeat endpoint uses `#/$defs/heartbeatEnvelope`.
- `schemas/edge-report-ack.v1.schema.json` — server-authored acknowledgement and
  lease boundary.
- `edge-report-signing.v1.md` — exact Ed25519 domain separator, canonical
  signing bytes, encodings, and golden vector.
- `schemas/problem.v1.schema.json` — stable problem codes.
- `schemas/public-office-snapshot.v1.schema.json` — consent-filtered public
  snapshot/SSE projection.
- `protocol-policy.v1.json` — rules that JSON Schema cannot express.
- `fixtures/` and `tests/` — positive, negative, privacy, sequencing, fencing,
  receive-time, and compatibility contract tests.

## Locked boundaries

- `server_received_at` is authoritative for leases, grace, intervals, rankings,
  and awards. Client `observed_at` is diagnostic only.
- `unknown` never opens an eligible-idle interval. Eligible-to-eligible
  transitions preserve the existing interval.
- Only the display/activity pairs listed in `protocol-policy.v1.json` are
  accepted, so blocked or failed states cannot accidentally open scoring.
- State transitions and heartbeats share one per-boot sequence space.
- A complete canonical replay is idempotent only while its boot remains current.
  A fenced boot always returns `stale_boot`. Reusing a sequence with different
  content is a conflict; gaps and partial overlaps reject the batch atomically.
- The official Edge rotates after at most 256 accepted events. Once its
  successor is accepted, the fenced boot's receipts and event fingerprints are
  deleted while its fencing tombstone remains. A successor received before
  lease expiry with the same activity classification preserves the continuous
  scoring interval; an expired lease or changed activity breaks it.
- Every envelope carries `previous_boot_id`. The first boot uses null; a new
  boot must compare-and-swap against the server's current boot, and sequence 1
  must be a complete state snapshot. This fences both known and previously
  unseen delayed old boots. Heartbeats only renew an established boot.
- Edge requests cannot include `idle_stage`, server receive timestamps, raw
  WorkBuddy content, session/tool/project data, mail content, or credentials.
- Public scene agents require `presence_visible`; rankings and awards require
  `stats_opt_in`; a new poster additionally requires `poster_opt_in` without
  broadening the underlying consent. Withdrawal advances `office_revision` and
  is removed from the next snapshot/SSE/new poster. A stored Daily Award is
  never reassigned after winner opt-out; its public projection becomes null.
- `leaderboard.office_local_date` equals `office.local_date`, the scoring
  office-day. A cross-midnight schedule window belongs to its starting date.
- Protocol v1 currently advertises
  `current_protocol = min_supported_protocol = 1`; it does not invent v0.
  Response schemas deliberately allow future N/N-1 values, and compatibility
  tests require both versions once v2 exists.

## Verification

From the repository root:

```sh
npm ci --ignore-scripts
npm run test:contracts
```

The dependencies are test-only and pinned in `package-lock.json`.

## Deliberately deferred

These contracts define the wire shape and acceptance semantics. M2A implements
one-time device enrollment and an active Ed25519 verifier. Account recovery,
credential replacement/revocation UI, and invitation-based membership remain
separate lifecycle milestones.
