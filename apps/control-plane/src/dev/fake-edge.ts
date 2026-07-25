const controlPlaneUrl =
  process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:3000";

const report = {
  protocol_version: 1,
  instance_id: "11111111-1111-4111-8111-111111111111",
  key_id: "33333333-3333-4333-8333-333333333333",
  boot_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  previous_boot_id: null,
  first_sequence: 1,
  events: [
    {
      sequence: 1,
      kind: "state_transition",
      observed_at: "2026-07-24T12:00:00Z",
      display_state: "done",
      activity_state: "eligible_idle",
      pet_id: "sora-shiba",
    },
  ],
  sent_at: "2026-07-24T12:00:01Z",
  client_version: "0.1.0",
  signature: `${"A".repeat(86)}==`,
};

const response = await fetch(
  new URL("/api/v1/edge/events:batch", controlPlaneUrl),
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  },
);
const body = await response.text();
process.stdout.write(`${response.status} ${body}\n`);
if (!response.ok) process.exitCode = 1;
