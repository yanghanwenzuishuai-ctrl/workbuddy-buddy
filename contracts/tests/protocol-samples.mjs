export const INSTANCE = "11111111-1111-4111-8111-111111111111";

export function envelope(bootId, events, overrides = {}) {
  return {
    protocol_version: 1,
    instance_id: INSTANCE,
    key_id: "33333333-3333-4333-8333-333333333333",
    boot_id: bootId,
    previous_boot_id: null,
    first_sequence: events[0].sequence,
    events,
    sent_at: "2026-07-24T12:00:00Z",
    client_version: "0.1.0",
    signature: "A".repeat(86) + "==",
    ...overrides,
  };
}

export function state(
  sequence,
  displayState = "idle",
  activityState = "eligible_idle",
  observedAt = "2026-07-24T12:00:00Z",
) {
  return {
    sequence,
    kind: "state_transition",
    observed_at: observedAt,
    display_state: displayState,
    activity_state: activityState,
    pet_id: "sora-shiba",
  };
}

export function heartbeat(sequence, observedAt = "2026-07-24T12:00:00Z") {
  return { sequence, kind: "heartbeat", observed_at: observedAt };
}
