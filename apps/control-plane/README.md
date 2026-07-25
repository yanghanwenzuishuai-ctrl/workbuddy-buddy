# WorkBuddy Buddy Control Plane

Milestone 1 is an isolated TypeScript modular monolith backed by PostgreSQL.
It implements the protocol's transactional boot/sequence ingestion core while
keeping real device enrollment and signature verification in Milestone 2.

## Local start

```bash
docker compose -f compose.control-plane.yml up --build
```

The default container exposes:

- `GET /livez`: process liveness only.
- `GET /readyz`: PostgreSQL connectivity and migration readiness.
- `POST /api/v1/edge/events:batch`
- `POST /api/v1/edge/heartbeat`

Edge writes are disabled unless a verifier is installed. For local fake-edge
work only, run the service outside production with
`ALLOW_UNVERIFIED_FAKE_EDGE=true`, seed the dev topology, and submit a fixture:

```bash
npm run migrate:control-plane
ALLOW_DEV_SEED=true npm run dev:seed --workspace @workbuddy-buddy/control-plane
ALLOW_UNVERIFIED_FAKE_EDGE=true npm run dev --workspace @workbuddy-buddy/control-plane
npm run dev:fake-edge --workspace @workbuddy-buddy/control-plane
```

The development verifier still requires a non-revoked database credential
bound to the active reporting instance. It only bypasses Ed25519 verification;
the bypass refuses to start when `NODE_ENV=production`.

Production startup does not run DDL by default. Run `db:migrate` as an
explicit release step with a migration-capable database role, then start the
service with a runtime role. `MIGRATE_ON_START=true` is intended for local
development and single-user self-hosting only.

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
When a successor boot is accepted, its predecessor's canonical payload bytes
and per-event replay fingerprints are scrubbed; the boot tombstone remains for
fencing. Before public beta, the protocol still needs an explicit maximum boot
lifetime or rollover policy so a never-ending current boot cannot grow its
heartbeat receipt ledger without bound.
