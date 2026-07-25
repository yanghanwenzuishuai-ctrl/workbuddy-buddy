import { createHash } from "node:crypto";

import { loadConfig } from "../config.js";
import { createPublicOfficeProjector } from "../modules/public-office/application/public-office-projector.js";
import { createPublicOfficeSnapshotValidator } from "../platform/contracts/public-office-snapshot-validator.js";
import { migrate } from "../platform/db/migrations.js";
import { createDatabasePool } from "../platform/db/pool.js";

export const DEV_IDS = {
  account: "44444444-4444-4444-8444-444444444444",
  office: "66666666-6666-4666-8666-666666666666",
  room: "77777777-7777-4777-8777-777777777777",
  agent: "55555555-5555-4555-8555-555555555555",
  instance: "11111111-1111-4111-8111-111111111111",
  key: "33333333-3333-4333-8333-333333333333",
  membership: "99999999-9999-4999-8999-999999999999",
  mount: "88888888-8888-4888-8888-888888888888",
  publicViewToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  scheduleVersion: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  qualification: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
} as const;

export const DEV_PUBLIC_VIEW_TOKEN =
  "workbuddy_demo_public_view_2026_07_25";

const SIMULATED_DEMO_AGENTS = [
  {
    agent: "55555555-5555-4555-8555-555555555556",
    instance: "11111111-1111-4111-8111-111111111112",
    boot: "22222222-2222-4222-8222-222222222212",
    mount: "88888888-8888-4888-8888-888888888889",
    qualification: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    interval: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
    alias: "Pico",
    petId: "pico-patch",
    sceneSlot: 1,
    displayState: "done",
    activityState: "eligible_idle",
    idleMinutes: 78,
  },
  {
    agent: "55555555-5555-4555-8555-555555555557",
    instance: "11111111-1111-4111-8111-111111111113",
    boot: "22222222-2222-4222-8222-222222222213",
    mount: "88888888-8888-4888-8888-88888888888a",
    qualification: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
    interval: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
    alias: "Bloop",
    petId: "bloop",
    sceneSlot: 2,
    displayState: "idle",
    activityState: "eligible_idle",
    idleMinutes: 48,
  },
  {
    agent: "55555555-5555-4555-8555-555555555558",
    instance: "11111111-1111-4111-8111-111111111114",
    boot: "22222222-2222-4222-8222-222222222214",
    mount: "88888888-8888-4888-8888-88888888888b",
    qualification: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
    interval: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3",
    alias: "Olli",
    petId: "olli-orbit",
    sceneSlot: 3,
    displayState: "done",
    activityState: "eligible_idle",
    idleMinutes: 29,
  },
  {
    agent: "55555555-5555-4555-8555-555555555559",
    instance: "11111111-1111-4111-8111-111111111115",
    boot: "22222222-2222-4222-8222-222222222215",
    mount: "88888888-8888-4888-8888-88888888888c",
    qualification: "cccccccc-cccc-4ccc-8ccc-ccccccccccc4",
    interval: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4",
    alias: "Nimbus",
    petId: "nimbus-noodle",
    sceneSlot: 4,
    displayState: "working",
    activityState: "active",
    idleMinutes: 0,
  },
  {
    agent: "55555555-5555-4555-8555-55555555555a",
    instance: "11111111-1111-4111-8111-111111111116",
    boot: "22222222-2222-4222-8222-222222222216",
    mount: "88888888-8888-4888-8888-88888888888d",
    qualification: "cccccccc-cccc-4ccc-8ccc-ccccccccccc5",
    interval: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5",
    alias: "Taro",
    petId: "taro-tinker",
    sceneSlot: 5,
    displayState: "waiting",
    activityState: "waiting",
    idleMinutes: 0,
  },
] as const;

const config = loadConfig();
if (
  config.nodeEnv === "production" ||
  process.env.ALLOW_DEV_SEED !== "true"
) {
  throw new Error(
    "The development seed requires non-production NODE_ENV and ALLOW_DEV_SEED=true",
  );
}
const pool = createDatabasePool(config);

try {
  await migrate(pool, config.migrationsDir);
  const publicSnapshotValidator =
    await createPublicOfficeSnapshotValidator(config.contractsDir);
  const publicOfficeProjector = createPublicOfficeProjector(
    publicSnapshotValidator,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const seededAt = new Date();
    await client.query(
      `INSERT INTO control_plane.accounts (id)
       VALUES ($1)
       ON CONFLICT (id) DO NOTHING`,
      [DEV_IDS.account],
    );
    await client.query(
      `INSERT INTO control_plane.offices (
       id, owner_account_id, name, discoverability, demo_data
       ) VALUES (
         $1, $2, '咸鱼王演示办公室', 'listed_demo', true
       )
       ON CONFLICT (id) DO UPDATE
         SET demo_data = true,
             timezone = 'Asia/Shanghai'`,
      [DEV_IDS.office, DEV_IDS.account],
    );
    await client.query(
      `UPDATE control_plane.offices
          SET timezone = 'Asia/Shanghai'
        WHERE id = $1`,
      [DEV_IDS.office],
    );
    await client.query(
      `INSERT INTO control_plane.rooms (
         id, office_id, name, scene_capacity
       ) VALUES ($1, $2, 'Lobby', 24)
       ON CONFLICT (id) DO NOTHING`,
      [DEV_IDS.room, DEV_IDS.office],
    );
    await client.query(
      `INSERT INTO control_plane.memberships (
         id, office_id, account_id
       ) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [DEV_IDS.membership, DEV_IDS.office, DEV_IDS.account],
    );
    await client.query(
      `INSERT INTO control_plane.logical_agents (
         id, owner_account_id, alias, pet_id
       ) VALUES ($1, $2, 'Sora', 'sora-shiba')
       ON CONFLICT (id) DO NOTHING`,
      [DEV_IDS.agent, DEV_IDS.account],
    );
    await client.query(
      `INSERT INTO control_plane.agent_instances (
         id, logical_agent_id
       ) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [DEV_IDS.instance, DEV_IDS.agent],
    );
    await client.query(
      `UPDATE control_plane.logical_agents
          SET active_reporting_instance_id = $2
        WHERE id = $1`,
      [DEV_IDS.agent, DEV_IDS.instance],
    );
    await client.query(
      `INSERT INTO control_plane.device_credentials (
         key_id, instance_id, public_key, valid_until
       ) VALUES (
         $1, $2, decode(repeat('00', 32), 'hex'),
         clock_timestamp() + interval '180 days'
       )
       ON CONFLICT (key_id) DO UPDATE
         SET revoked_at = NULL,
             valid_until = EXCLUDED.valid_until`,
      [DEV_IDS.key, DEV_IDS.instance],
    );
    await client.query(
      `INSERT INTO control_plane.edge_instance_heads (instance_id)
       VALUES ($1)
       ON CONFLICT (instance_id) DO NOTHING`,
      [DEV_IDS.instance],
    );
    await client.query(
      `INSERT INTO control_plane.agent_office_mounts (
         id, office_id, logical_agent_id, room_id,
         scene_slot, presence_visible, stats_opt_in, poster_opt_in
       ) VALUES ($1, $2, $3, $4, 0, true, true, true)
       ON CONFLICT (id) DO NOTHING`,
      [DEV_IDS.mount, DEV_IDS.office, DEV_IDS.agent, DEV_IDS.room],
    );
    await client.query(
      `INSERT INTO control_plane.office_public_view_tokens (
         id, office_id, token_hash
       ) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
         SET revoked_at = NULL,
             expires_at = NULL`,
      [
        DEV_IDS.publicViewToken,
        DEV_IDS.office,
        createHash("sha256")
          .update(DEV_PUBLIC_VIEW_TOKEN, "utf8")
          .digest(),
      ],
    );
    await client.query(
      `INSERT INTO control_plane.office_schedule_versions (
         id, office_id, version, timezone, effective_from_local_date
       ) VALUES ($1, $2, 1, 'Asia/Shanghai', DATE '2020-01-01')
       ON CONFLICT (id) DO NOTHING`,
      [DEV_IDS.scheduleVersion, DEV_IDS.office],
    );
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      const ruleId = `dddddddd-dddd-4ddd-8dd${weekday}-ddddddddddd${weekday}`;
      await client.query(
        `INSERT INTO control_plane.office_schedule_rules (
           id, office_id, schedule_version_id, iso_weekday,
           start_local_time, end_local_time, end_day_offset
         ) VALUES ($1, $2, $3, $4, TIME '00:00', TIME '00:00', 1)
         ON CONFLICT (id) DO NOTHING`,
        [ruleId, DEV_IDS.office, DEV_IDS.scheduleVersion, weekday],
      );
    }
    await client.query(
      `INSERT INTO control_plane.mount_stats_eligibility_intervals (
         id, office_id, mount_id, started_at
       )
       SELECT $1, mount.office_id, mount.id, mount.activated_at
         FROM control_plane.agent_office_mounts mount
        WHERE mount.id = $2
       ON CONFLICT (id) DO NOTHING`,
      [DEV_IDS.qualification, DEV_IDS.mount],
    );

    for (const demo of SIMULATED_DEMO_AGENTS) {
      const activityStartedAt = new Date(
        seededAt.getTime() - demo.idleMinutes * 60_000,
      );
      await client.query(
        `INSERT INTO control_plane.logical_agents (
           id, owner_account_id, alias, pet_id
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET alias = EXCLUDED.alias,
               pet_id = EXCLUDED.pet_id`,
        [demo.agent, DEV_IDS.account, demo.alias, demo.petId],
      );
      await client.query(
        `INSERT INTO control_plane.agent_instances (
           id, logical_agent_id
         ) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE
           SET status = 'active',
               revoked_at = NULL`,
        [demo.instance, demo.agent],
      );
      await client.query(
        `INSERT INTO control_plane.agent_instance_boots (
           instance_id, generation, boot_id, previous_boot_id,
           next_sequence, first_accepted_at, last_accepted_at
         ) VALUES ($1, 1, $2, NULL, 2, $3, $3)
         ON CONFLICT (instance_id, generation) DO UPDATE
           SET last_accepted_at = EXCLUDED.last_accepted_at`,
        [demo.instance, demo.boot, seededAt],
      );
      await client.query(
        `INSERT INTO control_plane.edge_instance_heads (
           instance_id, current_boot_id, current_boot_generation,
           last_server_received_at
         ) VALUES ($1, $2, 1, $3)
         ON CONFLICT (instance_id) DO UPDATE
           SET current_boot_id = EXCLUDED.current_boot_id,
               current_boot_generation = 1,
               last_server_received_at = EXCLUDED.last_server_received_at`,
        [demo.instance, demo.boot, seededAt],
      );
      await client.query(
        `UPDATE control_plane.logical_agents
            SET active_reporting_instance_id = $2
          WHERE id = $1`,
        [demo.agent, demo.instance],
      );
      await client.query(
        `INSERT INTO control_plane.current_presence (
           instance_id, boot_generation, boot_id,
           last_accepted_sequence, last_state_sequence,
           display_state, activity_state, pet_id,
           display_since, activity_since, eligible_since,
           last_report_received_at, lease_expires_at, lease_closed_at
         ) VALUES (
           $1, 1, $2,
           1, 1,
           $3, $4, $5,
           $6, $6, $7,
           $6, $6::timestamptz + interval '24 hours', NULL
         )
         ON CONFLICT (instance_id) DO UPDATE
           SET display_state = EXCLUDED.display_state,
               activity_state = EXCLUDED.activity_state,
               pet_id = EXCLUDED.pet_id,
               display_since = EXCLUDED.display_since,
               activity_since = EXCLUDED.activity_since,
               eligible_since = EXCLUDED.eligible_since,
               last_report_received_at = EXCLUDED.last_report_received_at,
               lease_expires_at = EXCLUDED.lease_expires_at,
               lease_closed_at = NULL`,
        [
          demo.instance,
          demo.boot,
          demo.displayState,
          demo.activityState,
          demo.petId,
          seededAt,
          demo.activityState === "eligible_idle"
            ? activityStartedAt
            : null,
        ],
      );
      await client.query(
        `INSERT INTO control_plane.derived_activity_intervals (
           id, instance_id, boot_generation, activity_state,
           started_at, start_sequence
         ) VALUES ($1, $2, 1, $3, $4, 1)
         ON CONFLICT (id) DO UPDATE
           SET activity_state = EXCLUDED.activity_state,
               started_at = EXCLUDED.started_at,
               ended_at = NULL,
               end_sequence = NULL,
               close_reason = NULL`,
        [
          demo.interval,
          demo.instance,
          demo.activityState,
          demo.activityState === "eligible_idle"
            ? activityStartedAt
            : seededAt,
        ],
      );
      await client.query(
        `INSERT INTO control_plane.agent_office_mounts (
           id, office_id, logical_agent_id, room_id,
           scene_slot, presence_visible, stats_opt_in, poster_opt_in
         ) VALUES ($1, $2, $3, $4, $5, true, true, true)
         ON CONFLICT (id) DO UPDATE
           SET active = true,
               deactivated_at = NULL,
               room_id = EXCLUDED.room_id,
               scene_slot = EXCLUDED.scene_slot,
               presence_visible = true,
               stats_opt_in = true,
               poster_opt_in = true,
               updated_at = $6`,
        [
          demo.mount,
          DEV_IDS.office,
          demo.agent,
          DEV_IDS.room,
          demo.sceneSlot,
          seededAt,
        ],
      );
      await client.query(
        `INSERT INTO control_plane.mount_stats_eligibility_intervals (
           id, office_id, mount_id, started_at
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [
          demo.qualification,
          DEV_IDS.office,
          demo.mount,
          activityStartedAt,
        ],
      );
    }

    const existingProjection = await client.query(
      `SELECT 1
         FROM control_plane.office_current_public_projections
        WHERE office_id = $1`,
      [DEV_IDS.office],
    );
    await publicOfficeProjector.recordRevision(client, {
      officeId: DEV_IDS.office,
      eventType:
        existingProjection.rowCount === 0
          ? "projection_initialized"
          : "projection_ticked",
      sourceKind:
        existingProjection.rowCount === 0
          ? "projection_seed"
          : "projection_tick",
      sourceKey: `dev-seed:${seededAt.toISOString()}`,
      sourceReceiptId: null,
      at: seededAt,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  process.stdout.write(
    `Development Office is ready at /o/${DEV_PUBLIC_VIEW_TOKEN}.\n`,
  );
} finally {
  await pool.end();
}
