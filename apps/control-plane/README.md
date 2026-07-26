# WorkBuddy Buddy Control Plane

The Control Plane is an isolated TypeScript modular monolith backed by
PostgreSQL. Milestone 2A adds a clickable onboarding flow and real device
enrollment/signature verification to the transactional boot/sequence ingestion
core delivered in Milestone 1.

## Local start

```bash
docker compose -f compose.control-plane.yml up --build
```

The default container exposes:

- `GET /livez`: process liveness only.
- `GET /readyz`: PostgreSQL connectivity and migration readiness.
- `POST /api/v1/onboarding/offices`: create an owned office and one-time pairing.
- `GET /api/v1/onboarding/pairings/:status_token`: poll that pairing's status.
- `POST /api/v1/edge/enrollment/claim`: bind a device public key to the pairing.
- `POST /api/v1/edge/events:batch`
- `POST /api/v1/edge/heartbeat`
- `GET /api/v1/offices/:public_view_token/snapshot`
- `GET /api/v1/offices/:public_view_token/events`
- `GET /start`: clickable create-and-pair page
- `GET /o/:public_view_token`: responsive Public Office page

## Pair a WorkBuddy pet

Open `/start`, choose the office name, buddy, and sharing options, then create
the office. The page displays a one-time pairing code and polls
`GET /api/v1/onboarding/pairings/:status_token`. In the native desktop app,
choose **menu-bar tray → 挂载到办公室 / Connect office…** and paste the code.
The page automatically opens the Public Office after the device claims it.

During the claim, the desktop app generates an Ed25519 device key. Only the
public key is sent to the Control Plane; the private key is kept in the
operating-system keychain and signs subsequent state updates and heartbeats.
The server resolves the active device credential and verifies each signature.
Set `WB_BUDDY_CONTROL_PLANE_URL` when launching the desktop app to override its
default hosted Control Plane, for example:

```bash
WB_BUDDY_CONTROL_PLANE_URL=http://127.0.0.1:3000 cargo run -p wb-buddy-app
```

Pairing currently creates a new office owned by that user. Joining an existing
office by invitation and Agent Mail identity verification are later milestones;
Agent Mail is not treated as an unattended bearer token.

For local fake-edge work only, run the service outside production with
`ALLOW_UNVERIFIED_FAKE_EDGE=true`, seed the dev topology, and submit a fixture:

```bash
npm run migrate:control-plane
ALLOW_DEV_SEED=true npm run dev:seed --workspace @workbuddy-buddy/control-plane
ALLOW_UNVERIFIED_FAKE_EDGE=true npm run dev --workspace @workbuddy-buddy/control-plane
npm run dev:fake-edge --workspace @workbuddy-buddy/control-plane
```

The seed prints its deterministic local-only Public Office URL. The page uses
the immutable Snapshot as its initial state and reconnects to the SSE stream
from that exact Office revision. Its layout is recording-safe at desktop,
9:16, and 3:4 viewports and loads no third-party resources.

The development verifier still requires a non-revoked database credential
bound to the active reporting instance. It only bypasses Ed25519 verification;
the bypass refuses to start when `NODE_ENV=production`.

Production startup does not run DDL by default. Run the compiled migration
entrypoint as an explicit release step with a migration-capable database role,
then start the service with a runtime role:

```bash
node apps/control-plane/dist/platform/db/migrate-cli.js
```

Use the same command as Railway's pre-deploy step. `MIGRATE_ON_START=true` is
intended for local development and single-user self-hosting only.

## Public Office guarantees

- Every published revision stores one complete, schema-validated canonical
  Snapshot. Snapshot bytes, the strong ETag, and an SSE replay frame cannot
  drift after publication.
- Public view capabilities are random 256-bit values. PostgreSQL stores only
  their SHA-256 digest; malformed, unknown, expired, rotated, and revoked
  values share the same no-store 404 response.
- Scene presence and statistics consent are independent. Lowering any consent
  creates a removal revision and invalidates unsafe historical replay.
- SSE replay holds a short shared database lock while each page of events is
  queued, so consent withdrawal or token revocation has a defined ordering
  with disclosure. Replays are bounded by revision count and a 1 MiB page
  budget; slow clients are disconnected.
- Scoring intersects server-derived eligible-idle activity, the active Lease,
  Mount statistics consent, and the materialized Office schedule. Each
  continuous intersection pays its own 15-minute grace. Overlapping source
  intervals are rejected and query-side intersections are merged defensively.
- A 30-second projection tick advances time-derived stages and rankings.
  Completed Office days are settled exactly once into an immutable winner or
  explicit `no_award`; zero-score days never receive a random winner.
- All capability-path responses are `private, no-store`. The share page sends
  `Referrer-Policy: no-referrer`, a same-origin CSP, and never inserts public
  values as HTML.

Important runtime settings:

- `PUBLIC_PROJECTION_TICK_SECONDS` (default `30`)
- `PUBLIC_REPLAY_MAX_REVISIONS` (default `256`)
- `PUBLIC_RETENTION_INTERVAL_SECONDS` (default `60`)
- `TRUST_PROXY_HOPS` (default `0`; set only for a verified ingress topology)

The account/member management API, invitations to an existing office, Agent
Mail identity challenge, and poster/short-video export pipeline remain separate
follow-up milestones.

## Verification

```bash
npm run typecheck:control-plane
npm run test:control-plane
ALLOW_CONTROL_PLANE_TEST_DB_RESET=true \
  CONTROL_PLANE_TEST_DATABASE_URL=postgres://... \
  npm run test:control-plane:integration
```

Integration tests require a real PostgreSQL database and reset only the
`control_plane` schema in that dedicated test database. The database name must
end in `_test`; otherwise the suite refuses to reset it.

This service accepts only the privacy-safe derived fields in the checked-in
JSON contract. It does not accept raw WorkBuddy spools, prompts, messages,
commands, paths, session IDs, tool content, or email content.

Protocol v1 retains receipt comparison bytes only while a boot is current.
The official Edge rotates after at most 256 accepted events and starts its
successor with a complete signed state snapshot. When that successor is
accepted, the predecessor's receipts and event fingerprints are deleted; only
the boot tombstone remains for fencing. A live same-activity rollover preserves
the continuous scoring boundary; a lease gap or changed activity breaks it.
Heartbeats that merely renew a live lease do not create redundant Public Office
revisions.
