export function validatePublicSnapshotSemantics(snapshot) {
  if (snapshot.leaderboard.office_local_date !== snapshot.office.local_date) {
    return "office_day_mismatch";
  }

  const rooms = new Map();
  for (const room of snapshot.rooms) {
    if (rooms.has(room.room_id)) return "duplicate_room";
    rooms.set(room.room_id, room);
  }

  const mounts = new Set();
  const occupiedSlots = new Set();
  for (const agent of snapshot.agents) {
    if (mounts.has(agent.mount_id)) return "duplicate_agent_mount";
    mounts.add(agent.mount_id);
    const room = rooms.get(agent.room_id);
    if (!room) return "unknown_room";
    if (agent.scene_slot === null) continue;
    if (agent.scene_slot >= room.scene_capacity) {
      return "scene_slot_out_of_capacity";
    }
    const slot = `${agent.room_id}:${agent.scene_slot}`;
    if (occupiedSlots.has(slot)) return "duplicate_scene_slot";
    occupiedSlots.add(slot);
  }

  const ranks = new Set();
  const rankedMounts = new Set();
  let previousScore = Number.POSITIVE_INFINITY;
  for (const [index, entry] of snapshot.leaderboard.entries.entries()) {
    if (ranks.has(entry.rank)) return "duplicate_rank";
    ranks.add(entry.rank);
    if (entry.rank !== index + 1) return "non_contiguous_rank";
    if (rankedMounts.has(entry.mount_id)) return "duplicate_ranked_mount";
    rankedMounts.add(entry.mount_id);
    if (entry.slacking_seconds > previousScore) {
      return "leaderboard_score_order";
    }
    previousScore = entry.slacking_seconds;
  }
  return null;
}
