import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import type {
  PublicOfficeSnapshot,
} from "../../modules/public-office/domain/types.js";
import type {
  PublicSnapshotValidator,
} from "../../modules/public-office/application/public-office-projector.js";

export async function createPublicOfficeSnapshotValidator(
  contractsDir: string,
): Promise<PublicSnapshotValidator> {
  const schema = JSON.parse(
    await readFile(
      path.join(
        contractsDir,
        "schemas/public-office-snapshot.v1.schema.json",
      ),
      "utf8",
    ),
  ) as object;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  const addFormats = (
    "default" in formatsModule ? formatsModule.default : formatsModule
  ) as unknown as FormatsPlugin;
  addFormats(ajv);
  const validate = ajv.compile(schema);
  return {
    assert(snapshot: unknown): asserts snapshot is PublicOfficeSnapshot {
      if (!validate(snapshot)) {
        throw new Error(
          `Public projection violates its JSON contract: ${safeErrors(validate)}`,
        );
      }
      assertSemanticInvariants(snapshot as PublicOfficeSnapshot);
    },
  };
}

function safeErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .slice(0, 4)
    .map((error: ErrorObject) => `${error.instancePath || "/"} ${error.keyword}`)
    .join(", ");
}

function assertSemanticInvariants(snapshot: PublicOfficeSnapshot): void {
  if (
    snapshot.office.local_date !==
    snapshot.leaderboard.office_local_date
  ) {
    throw new Error("Public projection has mismatched Office days");
  }

  const roomById = new Map(
    snapshot.rooms.map((room) => [room.room_id, room] as const),
  );
  if (roomById.size !== snapshot.rooms.length) {
    throw new Error("Public projection contains duplicate Rooms");
  }
  const mountIds = new Set<string>();
  const occupiedSlots = new Set<string>();
  for (const agent of snapshot.agents) {
    const room = roomById.get(agent.room_id);
    if (room === undefined) {
      throw new Error("Public projection Agent references an unknown Room");
    }
    if (mountIds.has(agent.mount_id)) {
      throw new Error("Public projection contains a duplicate Mount");
    }
    mountIds.add(agent.mount_id);
    if (agent.scene_slot !== null) {
      if (agent.scene_slot >= room.scene_capacity) {
        throw new Error("Public projection scene slot exceeds Room capacity");
      }
      const slotKey = `${agent.room_id}:${agent.scene_slot}`;
      if (occupiedSlots.has(slotKey)) {
        throw new Error("Public projection contains an occupied scene slot");
      }
      occupiedSlots.add(slotKey);
    }
  }

  const rankedMounts = new Set<string>();
  let previousScore = Number.POSITIVE_INFINITY;
  for (const [index, entry] of snapshot.leaderboard.entries.entries()) {
    if (entry.rank !== index + 1) {
      throw new Error("Public projection ranks are not contiguous");
    }
    if (rankedMounts.has(entry.mount_id)) {
      throw new Error("Public projection leaderboard repeats a Mount");
    }
    rankedMounts.add(entry.mount_id);
    if (entry.slacking_seconds > previousScore) {
      throw new Error("Public projection leaderboard is not score ordered");
    }
    previousScore = entry.slacking_seconds;
  }
}
