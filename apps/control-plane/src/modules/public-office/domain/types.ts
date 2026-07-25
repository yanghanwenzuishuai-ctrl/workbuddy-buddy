export type PublicIdleStage = "none" | "fresh" | "salted" | "costume" | "fish";

export interface PublicRoom {
  room_id: string;
  name: string;
  scene_capacity: number;
}

export interface PublicAgent {
  mount_id: string;
  room_id: string;
  alias: string;
  pet_id: string;
  presence: "online" | "offline";
  display_state: "idle" | "working" | "waiting" | "done" | "failed" | null;
  idle_stage: PublicIdleStage;
  scene_slot: number | null;
}

export interface PublicLeaderboardEntry {
  rank: number;
  mount_id: string;
  alias: string;
  pet_id: string;
  slacking_seconds: number;
}

export interface PublicDailyAward {
  office_local_date: string;
  awarded_at: string;
  final: true;
  winner: {
    mount_id: string;
    alias: string;
    pet_id: string;
    slacking_seconds: number;
  };
}

export interface PublicOfficeSnapshot {
  schema_version: 1;
  office_revision: number;
  generated_at: string;
  office: {
    name: string;
    local_date: string;
    timezone: string;
  };
  rooms: PublicRoom[];
  agents: PublicAgent[];
  leaderboard: {
    office_local_date: string;
    status: "provisional" | "final";
    as_of: string;
    entries: PublicLeaderboardEntry[];
  };
  daily_award: PublicDailyAward | null;
  demo_data: boolean;
  disclaimer: "趣味统计 · 非考勤依据";
}
