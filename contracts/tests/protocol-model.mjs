import { stableJson } from "./contract-helpers.mjs";

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function problem(code, extras = {}) {
  return { ok: false, code, ...extras };
}

export class ProtocolAcceptanceModel {
  constructor(policy) {
    this.policy = policy;
    this.instances = new Map();
    this.sideEffectCount = 0;
  }

  protocolDecision(version) {
    const { current, minimum_supported: minimum } = this.policy.protocol;
    if (!Number.isSafeInteger(version) || version < minimum || version > current) {
      return problem(this.policy.compatibility.unsupported_protocol_problem_code, {
        current_protocol: current,
        min_supported_protocol: minimum,
      });
    }
    return { ok: true };
  }

  protocolAdvertisementValid(current, minimum) {
    return (
      Number.isSafeInteger(current) &&
      Number.isSafeInteger(minimum) &&
      minimum >= 1 &&
      minimum <= current &&
      current - minimum + 1 <= this.policy.protocol.support_window
    );
  }

  accept(envelope, serverReceivedAt) {
    const protocol = this.protocolDecision(envelope.protocol_version);
    if (!protocol.ok) return protocol;
    if (!Number.isSafeInteger(serverReceivedAt) || serverReceivedAt < 0) {
      return problem("invalid_server_received_at");
    }
    if (hasClientAuthorityField(envelope)) {
      return problem("client_authority_field");
    }

    const events = envelope.events;
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.length > this.policy.batch.maximum_events
    ) {
      return problem("invalid_batch_size");
    }
    if (
      !Number.isSafeInteger(envelope.first_sequence) ||
      envelope.first_sequence < this.policy.batch.sequence_starts_at ||
      events[0]?.sequence !== envelope.first_sequence
    ) {
      return problem("report_semantics_invalid");
    }
    for (let index = 0; index < events.length; index += 1) {
      const expected = envelope.first_sequence + index;
      const actual = events[index].sequence;
      if (!Number.isSafeInteger(actual)) return problem("report_semantics_invalid");
      if (actual > expected) {
        return problem(this.policy.batch.gap, { expected_sequence: expected });
      }
      if (actual < expected) {
        return problem(this.policy.batch.partial_overlap, {
          expected_sequence: expected,
        });
      }
      if (
        events[index].kind === "state_transition" &&
        !this.isAllowedStatePair(
          events[index].display_state,
          events[index].activity_state,
        )
      ) {
        return problem("report_semantics_invalid");
      }
    }

    let instance = this.instances.get(envelope.instance_id);
    const isNewInstance = instance === undefined;
    if (!instance) {
      instance = {
        currentBoot: null,
        generation: 0,
        boots: new Map(),
        presence: null,
        leaseRenewedAt: null,
        eligibleSince: null,
      };
    }

    let boot = instance.boots.get(envelope.boot_id);
    if (instance.currentBoot !== envelope.boot_id) {
      if (boot) return problem("stale_boot");
      if (envelope.first_sequence !== this.policy.batch.sequence_starts_at) {
        return problem("sequence_gap", {
          expected_sequence: this.policy.batch.sequence_starts_at,
        });
      }
      if (events[0].kind !== this.policy.boot_fencing.new_boot_first_event_kind) {
        return problem("report_semantics_invalid");
      }
      if (
        envelope.previous_boot_id !==
        (instance.currentBoot ?? this.policy.boot_fencing.initial_previous_boot_id)
      ) {
        return problem(this.policy.boot_fencing.mismatch_problem_code);
      }
      boot = {
        generation: instance.generation + 1,
        previousBoot: envelope.previous_boot_id,
        nextSequence: this.policy.batch.sequence_starts_at,
        acceptedEvents: new Map(),
        acceptedBatches: new Map(),
        acceptedRanges: new Map(),
      };
    } else if (envelope.previous_boot_id !== boot.previousBoot) {
      return problem(this.policy.boot_fencing.mismatch_problem_code);
    }

    const lastSequence = envelope.first_sequence + events.length - 1;
    const rangeKey = `${envelope.first_sequence}:${lastSequence}`;
    const canonicalPayload = stableJson(envelope);
    const batchKey = `${rangeKey}:${canonicalPayload}`;

    if (envelope.first_sequence < boot.nextSequence) {
      const previousAck = boot.acceptedBatches.get(batchKey);
      if (previousAck) return copy(previousAck);
      if (boot.acceptedRanges.has(rangeKey)) {
        return problem("sequence_conflict", {
          expected_sequence: boot.nextSequence,
        });
      }

      for (const event of events) {
        const prior = boot.acceptedEvents.get(event.sequence);
        if (prior !== undefined && prior !== eventFingerprint(event)) {
          return problem("sequence_conflict", {
            expected_sequence: boot.nextSequence,
          });
        }
      }
      return problem("sequence_overlap", {
        expected_sequence: boot.nextSequence,
      });
    }
    if (envelope.first_sequence > boot.nextSequence) {
      return problem("sequence_gap", { expected_sequence: boot.nextSequence });
    }

    // All rejection paths precede this point: committing the candidate boot and
    // its events is intentionally atomic.
    if (instance.currentBoot !== envelope.boot_id) {
      if (isNewInstance) this.instances.set(envelope.instance_id, instance);
      instance.generation = boot.generation;
      instance.currentBoot = envelope.boot_id;
      instance.boots.set(envelope.boot_id, boot);
      instance.presence = null;
      instance.eligibleSince = null;
    }
    for (const event of events) {
      boot.acceptedEvents.set(event.sequence, eventFingerprint(event));
      if (event.kind === "state_transition") {
        instance.presence = {
          display_state: event.display_state,
          activity_state: event.activity_state,
          server_received_at: serverReceivedAt,
        };
        if (event.activity_state === "eligible_idle") {
          // Eligible -> Eligible preserves the continuous interval. Only an
          // active/blocked state, lease loss, or a new boot clears the boundary.
          instance.eligibleSince ??= serverReceivedAt;
        } else {
          instance.eligibleSince = null;
        }
      }
    }
    boot.nextSequence = lastSequence + 1;
    instance.leaseRenewedAt = serverReceivedAt;
    this.sideEffectCount += events.length;

    const leaseTtl = this.policy.presence.default_lease_ttl_seconds * 1000;
    const ack = {
      ok: true,
      current_protocol: this.policy.protocol.current,
      min_supported_protocol: this.policy.protocol.minimum_supported,
      instance_id: envelope.instance_id,
      boot_id: envelope.boot_id,
      accepted_through_sequence: lastSequence,
      server_received_at: serverReceivedAt,
      lease_expires_at: serverReceivedAt + leaseTtl,
    };
    boot.acceptedBatches.set(batchKey, copy(ack));
    boot.acceptedRanges.set(rangeKey, canonicalPayload);
    return ack;
  }

  inspect(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance) return null;
    const boot = instance.boots.get(instance.currentBoot);
    return copy({
      currentBoot: instance.currentBoot,
      generation: instance.generation,
      expectedSequence: boot.nextSequence,
      presence: instance.presence,
      leaseRenewedAt: instance.leaseRenewedAt,
      eligibleSince: instance.eligibleSince,
    });
  }

  isAllowedStatePair(displayState, activityState) {
    return this.policy.state_transition.allowed_display_activity_pairs.some(
      ([allowedDisplay, allowedActivity]) =>
        displayState === allowedDisplay && activityState === allowedActivity,
    );
  }
}

function eventFingerprint(event) {
  return stableJson(event);
}

function hasClientAuthorityField(value) {
  if (Array.isArray(value)) return value.some(hasClientAuthorityField);
  if (value === null || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "received_at" || key === "server_received_at" || key === "idle_stage") {
      return true;
    }
    if (hasClientAuthorityField(child)) return true;
  }
  return false;
}
