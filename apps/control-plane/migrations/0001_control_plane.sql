CREATE SCHEMA IF NOT EXISTS control_plane;

CREATE TABLE control_plane.accounts (
    id uuid PRIMARY KEY,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'deleting', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deletion_requested_at timestamptz,
    purge_after timestamptz,
    CHECK (
        (status = 'active' AND deletion_requested_at IS NULL AND purge_after IS NULL)
        OR
        (status <> 'active' AND deletion_requested_at IS NOT NULL AND purge_after IS NOT NULL)
    )
);

CREATE TABLE control_plane.offices (
    id uuid PRIMARY KEY,
    owner_account_id uuid NOT NULL
        REFERENCES control_plane.accounts(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    timezone text NOT NULL DEFAULT 'Asia/Shanghai'
        CHECK (length(timezone) BETWEEN 1 AND 64),
    locale text NOT NULL DEFAULT 'zh-CN'
        CHECK (length(locale) BETWEEN 2 AND 16),
    discoverability text NOT NULL DEFAULT 'unlisted'
        CHECK (discoverability IN ('unlisted', 'listed_demo')),
    revision bigint NOT NULL DEFAULT 0
        CHECK (revision BETWEEN 0 AND 9007199254740991),
    minimum_replay_revision bigint NOT NULL DEFAULT 0
        CHECK (minimum_replay_revision BETWEEN 0 AND 9007199254740991),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deletion_requested_at timestamptz,
    purge_after timestamptz,
    CHECK (minimum_replay_revision <= revision)
);

CREATE TABLE control_plane.rooms (
    id uuid PRIMARY KEY,
    office_id uuid NOT NULL
        REFERENCES control_plane.offices(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    scene_capacity smallint NOT NULL DEFAULT 12
        CHECK (scene_capacity BETWEEN 1 AND 24),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (office_id, id),
    UNIQUE (office_id, name)
);

CREATE TABLE control_plane.memberships (
    id uuid PRIMARY KEY,
    office_id uuid NOT NULL
        REFERENCES control_plane.offices(id) ON DELETE CASCADE,
    account_id uuid NOT NULL
        REFERENCES control_plane.accounts(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (office_id, account_id)
);

COMMENT ON TABLE control_plane.memberships IS
    'Office membership only. offices.owner_account_id is the single source of truth for ownership.';

CREATE TABLE control_plane.logical_agents (
    id uuid PRIMARY KEY,
    owner_account_id uuid NOT NULL
        REFERENCES control_plane.accounts(id) ON DELETE CASCADE,
    alias text NOT NULL CHECK (length(alias) BETWEEN 1 AND 40),
    pet_id text NOT NULL
        CHECK (
            length(pet_id) BETWEEN 1 AND 64
            AND pet_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
        ),
    active_reporting_instance_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    archived_at timestamptz
);

CREATE TABLE control_plane.agent_instances (
    id uuid PRIMARY KEY,
    logical_agent_id uuid NOT NULL
        REFERENCES control_plane.logical_agents(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    UNIQUE (logical_agent_id, id),
    CHECK (
        (status = 'active' AND revoked_at IS NULL)
        OR
        (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

ALTER TABLE control_plane.logical_agents
    ADD CONSTRAINT logical_agents_active_instance_belongs_to_agent
    FOREIGN KEY (id, active_reporting_instance_id)
    REFERENCES control_plane.agent_instances(logical_agent_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX agent_instances_by_logical_agent
    ON control_plane.agent_instances (logical_agent_id);

CREATE TABLE control_plane.device_credentials (
    key_id uuid PRIMARY KEY,
    instance_id uuid NOT NULL
        REFERENCES control_plane.agent_instances(id) ON DELETE CASCADE,
    algorithm text NOT NULL DEFAULT 'ed25519'
        CHECK (algorithm = 'ed25519'),
    public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    valid_until timestamptz NOT NULL,
    revoked_at timestamptz,
    UNIQUE (instance_id, key_id)
);

CREATE INDEX device_credentials_active_by_instance
    ON control_plane.device_credentials (instance_id, valid_until)
    WHERE revoked_at IS NULL;

CREATE TABLE control_plane.edge_instance_heads (
    instance_id uuid PRIMARY KEY
        REFERENCES control_plane.agent_instances(id) ON DELETE CASCADE,
    current_boot_id uuid,
    current_boot_generation bigint NOT NULL DEFAULT 0
        CHECK (current_boot_generation BETWEEN 0 AND 9007199254740991),
    last_server_received_at timestamptz,
    CHECK (
        (current_boot_generation = 0 AND current_boot_id IS NULL)
        OR
        (current_boot_generation > 0 AND current_boot_id IS NOT NULL)
    )
);

CREATE TABLE control_plane.agent_instance_boots (
    instance_id uuid NOT NULL
        REFERENCES control_plane.agent_instances(id) ON DELETE CASCADE,
    generation bigint NOT NULL
        CHECK (generation BETWEEN 1 AND 9007199254740991),
    boot_id uuid NOT NULL,
    previous_boot_id uuid,
    next_sequence bigint NOT NULL DEFAULT 1
        CHECK (next_sequence BETWEEN 1 AND 9007199254740992),
    first_accepted_at timestamptz NOT NULL,
    last_accepted_at timestamptz NOT NULL,
    fenced_at timestamptz,
    PRIMARY KEY (instance_id, generation),
    UNIQUE (instance_id, boot_id),
    UNIQUE (instance_id, generation, boot_id),
    CHECK (
        (generation = 1 AND previous_boot_id IS NULL)
        OR
        (generation > 1 AND previous_boot_id IS NOT NULL)
    ),
    FOREIGN KEY (instance_id, previous_boot_id)
        REFERENCES control_plane.agent_instance_boots(instance_id, boot_id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX agent_instance_boots_one_successor
    ON control_plane.agent_instance_boots (instance_id, previous_boot_id)
    WHERE previous_boot_id IS NOT NULL;

ALTER TABLE control_plane.edge_instance_heads
    ADD CONSTRAINT edge_instance_heads_current_boot_fk
    FOREIGN KEY (instance_id, current_boot_generation, current_boot_id)
    REFERENCES control_plane.agent_instance_boots(instance_id, generation, boot_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE control_plane.edge_report_receipts (
    id uuid PRIMARY KEY,
    instance_id uuid NOT NULL,
    boot_generation bigint NOT NULL,
    boot_id uuid NOT NULL,
    key_id uuid NOT NULL
        REFERENCES control_plane.device_credentials(key_id) ON DELETE RESTRICT,
    first_sequence bigint NOT NULL
        CHECK (first_sequence BETWEEN 1 AND 9007199254740991),
    last_sequence bigint NOT NULL
        CHECK (last_sequence BETWEEN 1 AND 9007199254740991),
    event_count smallint NOT NULL CHECK (event_count BETWEEN 1 AND 64),
    canonical_sha256 bytea NOT NULL CHECK (octet_length(canonical_sha256) = 32),
    canonical_payload bytea NOT NULL,
    sent_at timestamptz NOT NULL,
    client_version text NOT NULL CHECK (length(client_version) BETWEEN 5 AND 64),
    server_received_at timestamptz NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    current_protocol bigint NOT NULL CHECK (current_protocol >= 1),
    min_supported_protocol bigint NOT NULL
        CHECK (min_supported_protocol BETWEEN 1 AND current_protocol),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (last_sequence = first_sequence + event_count - 1),
    UNIQUE (
        instance_id,
        boot_generation,
        first_sequence,
        last_sequence
    ),
    FOREIGN KEY (instance_id, boot_generation, boot_id)
        REFERENCES control_plane.agent_instance_boots(instance_id, generation, boot_id)
        ON DELETE CASCADE
);

CREATE INDEX edge_report_receipts_by_current_boot
    ON control_plane.edge_report_receipts
    (instance_id, boot_generation, first_sequence);

CREATE TABLE control_plane.edge_event_fingerprints (
    instance_id uuid NOT NULL,
    boot_generation bigint NOT NULL,
    sequence bigint NOT NULL
        CHECK (sequence BETWEEN 1 AND 9007199254740991),
    receipt_id uuid NOT NULL
        REFERENCES control_plane.edge_report_receipts(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('state_transition', 'heartbeat')),
    canonical_sha256 bytea NOT NULL CHECK (octet_length(canonical_sha256) = 32),
    canonical_event bytea NOT NULL,
    observed_at timestamptz NOT NULL,
    display_state text,
    activity_state text,
    pet_id text,
    PRIMARY KEY (instance_id, boot_generation, sequence),
    CHECK (
        (
            kind = 'heartbeat'
            AND display_state IS NULL
            AND activity_state IS NULL
            AND pet_id IS NULL
        )
        OR
        (
            kind = 'state_transition'
            AND display_state IS NOT NULL
            AND activity_state IS NOT NULL
            AND pet_id IS NOT NULL
            AND length(pet_id) BETWEEN 1 AND 64
            AND pet_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
        )
    ),
    CHECK (
        kind = 'heartbeat'
        OR (display_state = 'idle' AND activity_state IN ('unknown', 'eligible_idle'))
        OR (display_state = 'working' AND activity_state = 'active')
        OR (display_state = 'waiting' AND activity_state IN ('waiting', 'active', 'eligible_idle'))
        OR (display_state = 'done' AND activity_state = 'eligible_idle')
        OR (display_state = 'failed' AND activity_state = 'failed')
    ),
    FOREIGN KEY (instance_id, boot_generation)
        REFERENCES control_plane.agent_instance_boots(instance_id, generation)
        ON DELETE CASCADE
);

CREATE TABLE control_plane.current_presence (
    instance_id uuid PRIMARY KEY
        REFERENCES control_plane.agent_instances(id) ON DELETE CASCADE,
    boot_generation bigint NOT NULL,
    boot_id uuid NOT NULL,
    last_accepted_sequence bigint NOT NULL
        CHECK (last_accepted_sequence BETWEEN 1 AND 9007199254740991),
    last_state_sequence bigint NOT NULL
        CHECK (last_state_sequence BETWEEN 1 AND 9007199254740991),
    display_state text NOT NULL,
    activity_state text NOT NULL,
    pet_id text NOT NULL
        CHECK (
            length(pet_id) BETWEEN 1 AND 64
            AND pet_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
        ),
    display_since timestamptz NOT NULL,
    activity_since timestamptz NOT NULL,
    eligible_since timestamptz,
    last_report_received_at timestamptz NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    lease_closed_at timestamptz,
    CHECK (
        (display_state = 'idle' AND activity_state IN ('unknown', 'eligible_idle'))
        OR (display_state = 'working' AND activity_state = 'active')
        OR (display_state = 'waiting' AND activity_state IN ('waiting', 'active', 'eligible_idle'))
        OR (display_state = 'done' AND activity_state = 'eligible_idle')
        OR (display_state = 'failed' AND activity_state = 'failed')
    ),
    CHECK (
        (activity_state = 'eligible_idle' AND eligible_since IS NOT NULL)
        OR
        (activity_state <> 'eligible_idle' AND eligible_since IS NULL)
    ),
    CHECK (last_accepted_sequence >= last_state_sequence),
    CHECK (lease_expires_at > last_report_received_at),
    CHECK (lease_closed_at IS NULL OR lease_closed_at = lease_expires_at),
    FOREIGN KEY (instance_id, boot_generation, boot_id)
        REFERENCES control_plane.agent_instance_boots(instance_id, generation, boot_id)
        ON DELETE CASCADE
);

CREATE INDEX current_presence_by_lease_expiry
    ON control_plane.current_presence (lease_expires_at);

CREATE TABLE control_plane.derived_activity_intervals (
    id uuid PRIMARY KEY,
    instance_id uuid NOT NULL
        REFERENCES control_plane.agent_instances(id) ON DELETE CASCADE,
    boot_generation bigint NOT NULL,
    activity_state text NOT NULL
        CHECK (activity_state IN ('unknown', 'active', 'eligible_idle', 'waiting', 'failed')),
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    start_sequence bigint NOT NULL
        CHECK (start_sequence BETWEEN 1 AND 9007199254740991),
    end_sequence bigint
        CHECK (end_sequence BETWEEN 1 AND 9007199254740991),
    close_reason text
        CHECK (
            close_reason IS NULL
            OR close_reason IN (
                'state_changed',
                'lease_expired',
                'boot_replaced',
                'instance_revoked',
                'retention'
            )
        ),
    CHECK (
        (ended_at IS NULL AND end_sequence IS NULL AND close_reason IS NULL)
        OR
        (
            ended_at IS NOT NULL
            AND ended_at >= started_at
            AND end_sequence IS NOT NULL
            AND close_reason IS NOT NULL
        )
    ),
    CHECK (end_sequence IS NULL OR end_sequence >= start_sequence),
    FOREIGN KEY (instance_id, boot_generation)
        REFERENCES control_plane.agent_instance_boots(instance_id, generation)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX derived_activity_intervals_one_open
    ON control_plane.derived_activity_intervals (instance_id)
    WHERE ended_at IS NULL;

CREATE TABLE control_plane.agent_office_mounts (
    id uuid PRIMARY KEY,
    office_id uuid NOT NULL
        REFERENCES control_plane.offices(id) ON DELETE CASCADE,
    logical_agent_id uuid NOT NULL
        REFERENCES control_plane.logical_agents(id) ON DELETE CASCADE,
    room_id uuid NOT NULL,
    active boolean NOT NULL DEFAULT true,
    scene_slot smallint CHECK (scene_slot BETWEEN 0 AND 23),
    presence_visible boolean NOT NULL DEFAULT false,
    stats_opt_in boolean NOT NULL DEFAULT false,
    poster_opt_in boolean NOT NULL DEFAULT false,
    activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deactivated_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (office_id, logical_agent_id),
    UNIQUE (office_id, id),
    FOREIGN KEY (office_id, room_id)
        REFERENCES control_plane.rooms(office_id, id) ON DELETE RESTRICT,
    CHECK (
        (active AND deactivated_at IS NULL)
        OR
        (NOT active AND deactivated_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX agent_office_mounts_scene_slot
    ON control_plane.agent_office_mounts (office_id, room_id, scene_slot)
    WHERE active AND scene_slot IS NOT NULL;

CREATE TABLE control_plane.presence_eligibility_intervals (
    id uuid PRIMARY KEY,
    office_id uuid NOT NULL,
    mount_id uuid NOT NULL,
    instance_id uuid NOT NULL
        REFERENCES control_plane.agent_instances(id) ON DELETE CASCADE,
    boot_generation bigint NOT NULL,
    office_local_date date NOT NULL,
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    close_reason text,
    FOREIGN KEY (office_id, mount_id)
        REFERENCES control_plane.agent_office_mounts(office_id, id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id, boot_generation)
        REFERENCES control_plane.agent_instance_boots(instance_id, generation)
        ON DELETE CASCADE,
    CHECK (
        (ended_at IS NULL AND close_reason IS NULL)
        OR
        (ended_at IS NOT NULL AND ended_at >= started_at AND close_reason IS NOT NULL)
    )
);

CREATE UNIQUE INDEX presence_eligibility_intervals_one_open
    ON control_plane.presence_eligibility_intervals (mount_id)
    WHERE ended_at IS NULL;

CREATE INDEX presence_eligibility_intervals_office_day
    ON control_plane.presence_eligibility_intervals (office_id, office_local_date);

CREATE TABLE control_plane.office_revision_events (
    office_id uuid NOT NULL
        REFERENCES control_plane.offices(id) ON DELETE CASCADE,
    revision bigint NOT NULL
        CHECK (revision BETWEEN 1 AND 9007199254740991),
    event_type text NOT NULL
        CHECK (event_type IN ('presence_changed', 'presence_removed', 'resync_required')),
    public_payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (office_id, revision)
);

CREATE TABLE control_plane.domain_outbox (
    id uuid PRIMARY KEY,
    office_id uuid NOT NULL
        REFERENCES control_plane.offices(id) ON DELETE CASCADE,
    office_revision bigint NOT NULL,
    source_kind text NOT NULL
        CHECK (source_kind IN ('edge_receipt', 'lease_expiry')),
    source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 160),
    source_receipt_id uuid
        REFERENCES control_plane.edge_report_receipts(id) ON DELETE SET NULL,
    effect_kind text NOT NULL CHECK (effect_kind = 'office_revision'),
    public_payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    published_at timestamptz,
    UNIQUE (office_id, source_kind, source_key, effect_kind),
    FOREIGN KEY (office_id, office_revision)
        REFERENCES control_plane.office_revision_events(office_id, revision)
        ON DELETE CASCADE
);

CREATE INDEX domain_outbox_unpublished
    ON control_plane.domain_outbox (created_at, id)
    WHERE published_at IS NULL;

COMMENT ON SCHEMA control_plane IS
    'Privacy-safe WorkBuddy Buddy Control Plane state. Raw WorkBuddy content and mailbox content are forbidden.';

COMMENT ON COLUMN control_plane.edge_report_receipts.canonical_payload IS
    'Canonical bytes of the schema-validated privacy-safe report. Required for exact current-boot replay and scrubbed when that boot is fenced.';
