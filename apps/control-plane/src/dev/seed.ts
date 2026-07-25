import { loadConfig } from "../config.js";
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
} as const;

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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO control_plane.accounts (id)
       VALUES ($1)
       ON CONFLICT (id) DO NOTHING`,
      [DEV_IDS.account],
    );
    await client.query(
      `INSERT INTO control_plane.offices (
         id, owner_account_id, name, discoverability
       ) VALUES ($1, $2, '咸鱼王演示办公室', 'listed_demo')
       ON CONFLICT (id) DO NOTHING`,
      [DEV_IDS.office, DEV_IDS.account],
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  process.stdout.write("Development Office and fake Edge instance are ready.\n");
} finally {
  await pool.end();
}
