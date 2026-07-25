CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE control_plane.offices
    ADD COLUMN demo_data boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT offices_public_name_safe
        CHECK (name !~ '[\r\n]');

ALTER TABLE control_plane.rooms
    ADD CONSTRAINT rooms_public_name_safe
        CHECK (name !~ '[\r\n]');

ALTER TABLE control_plane.logical_agents
    ADD CONSTRAINT logical_agents_public_alias_safe
        CHECK (
            length(alias) BETWEEN 1 AND 32
            AND alias !~ '[@\r\n]'
        );

CREATE TABLE control_plane.office_public_view_tokens (
    id uuid PRIMARY KEY,
    office_id uuid NOT NULL
        REFERENCES control_plane.offices(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE
        CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz,
    revoked_at timestamptz,
    CHECK (expires_at IS NULL OR expires_at > created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX office_public_view_tokens_one_active
    ON control_plane.office_public_view_tokens (office_id)
    WHERE revoked_at IS NULL;

COMMENT ON COLUMN control_plane.office_public_view_tokens.token_hash IS
    'SHA-256 of a high-entropy public view capability. The raw token is never persisted.';

CREATE TABLE control_plane.office_schedule_versions (
    id uuid PRIMARY KEY,
    office_id uuid NOT NULL
        REFERENCES control_plane.offices(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version >= 1),
    timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
    effective_from_local_date date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (office_id, version),
    UNIQUE (office_id, effective_from_local_date),
    UNIQUE (office_id, id)
);

CREATE TABLE control_plane.office_schedule_rules (
    id uuid PRIMARY KEY,
    office_id uuid NOT NULL,
    schedule_version_id uuid NOT NULL,
    iso_weekday smallint NOT NULL CHECK (iso_weekday BETWEEN 1 AND 7),
    start_local_time time NOT NULL,
    end_local_time time NOT NULL,
    end_day_offset smallint NOT NULL DEFAULT 0
        CHECK (end_day_offset IN (0, 1)),
    UNIQUE (office_id, id),
    UNIQUE (schedule_version_id, iso_weekday, start_local_time),
    FOREIGN KEY (office_id, schedule_version_id)
        REFERENCES control_plane.office_schedule_versions(office_id, id)
        ON DELETE CASCADE,
    CHECK (
        (end_day_offset = 0 AND end_local_time > start_local_time)
        OR end_day_offset = 1
    )
);

CREATE TABLE control_plane.office_schedule_occurrences (
    id uuid PRIMARY KEY,
    office_id uuid NOT NULL,
    schedule_version_id uuid NOT NULL,
    schedule_rule_id uuid NOT NULL,
    office_local_date date NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (schedule_rule_id, office_local_date),
    UNIQUE (office_id, id),
    FOREIGN KEY (office_id, schedule_version_id)
        REFERENCES control_plane.office_schedule_versions(office_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (office_id, schedule_rule_id)
        REFERENCES control_plane.office_schedule_rules(office_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    CHECK (ends_at > starts_at)
);

CREATE INDEX office_schedule_occurrences_lookup
    ON control_plane.office_schedule_occurrences
    (office_id, office_local_date, starts_at, ends_at);

CREATE INDEX office_schedule_occurrences_due
    ON control_plane.office_schedule_occurrences (ends_at, office_id);

CREATE TABLE control_plane.mount_stats_eligibility_intervals (
    id uuid PRIMARY KEY,
    office_id uuid NOT NULL,
    mount_id uuid NOT NULL,
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    close_reason text
        CHECK (
            close_reason IS NULL
            OR close_reason IN (
                'stats_opt_out',
                'mount_deactivated',
                'mount_removed',
                'account_deleted'
            )
        ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (office_id, mount_id)
        REFERENCES control_plane.agent_office_mounts(office_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    CHECK (
        (ended_at IS NULL AND close_reason IS NULL)
        OR (
            ended_at IS NOT NULL
            AND ended_at >= started_at
            AND close_reason IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX mount_stats_eligibility_intervals_one_open
    ON control_plane.mount_stats_eligibility_intervals (mount_id)
    WHERE ended_at IS NULL;

CREATE INDEX mount_stats_eligibility_intervals_office_time
    ON control_plane.mount_stats_eligibility_intervals
    (office_id, started_at, ended_at);

ALTER TABLE control_plane.presence_eligibility_intervals
    ADD COLUMN schedule_occurrence_id uuid,
    ADD COLUMN qualification_interval_id uuid,
    ADD CONSTRAINT presence_eligibility_schedule_occurrence_fk
        FOREIGN KEY (office_id, schedule_occurrence_id)
        REFERENCES control_plane.office_schedule_occurrences(office_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT presence_eligibility_qualification_interval_fk
        FOREIGN KEY (qualification_interval_id)
        REFERENCES control_plane.mount_stats_eligibility_intervals(id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT presence_eligibility_projection_sources_pair
        CHECK (
            (schedule_occurrence_id IS NULL AND qualification_interval_id IS NULL)
            OR
            (schedule_occurrence_id IS NOT NULL AND qualification_interval_id IS NOT NULL)
        );

CREATE INDEX presence_eligibility_intervals_score_lookup
    ON control_plane.presence_eligibility_intervals
    (office_id, office_local_date, schedule_occurrence_id, mount_id);

ALTER TABLE control_plane.office_revision_events
    DROP CONSTRAINT office_revision_events_event_type_check,
    ADD CONSTRAINT office_revision_events_event_type_check
        CHECK (
            event_type IN (
                'projection_initialized',
                'projection_ticked',
                'presence_changed',
                'presence_removed',
                'consent_changed',
                'schedule_changed',
                'office_day_settled'
            )
        ),
    ADD COLUMN projection_format_version smallint NOT NULL DEFAULT 0
        CHECK (projection_format_version IN (0, 1)),
    ADD COLUMN canonical_payload bytea;

ALTER TABLE control_plane.office_revision_events
    ADD CONSTRAINT office_revision_events_projection_payload_complete
        CHECK (
            (projection_format_version = 0 AND canonical_payload IS NULL)
            OR
            (projection_format_version = 1 AND canonical_payload IS NOT NULL)
        );

COMMENT ON COLUMN control_plane.office_revision_events.public_payload IS
    'Format 1 rows contain one immutable complete public-office-snapshot. Legacy format 0 rows are never replayed.';

UPDATE control_plane.offices
   SET minimum_replay_revision = revision
 WHERE revision > minimum_replay_revision;

CREATE TABLE control_plane.office_current_public_projections (
    office_id uuid PRIMARY KEY
        REFERENCES control_plane.offices(id) ON DELETE CASCADE,
    revision bigint NOT NULL
        CHECK (revision BETWEEN 1 AND 9007199254740991),
    snapshot_payload jsonb NOT NULL
        CHECK (jsonb_typeof(snapshot_payload) = 'object'),
    canonical_payload bytea NOT NULL,
    generated_at timestamptz NOT NULL,
    FOREIGN KEY (office_id, revision)
        REFERENCES control_plane.office_revision_events(office_id, revision)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE control_plane.office_day_results (
    office_id uuid NOT NULL
        REFERENCES control_plane.offices(id) ON DELETE CASCADE,
    office_local_date date NOT NULL,
    schedule_version_id uuid NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('winner', 'no_award')),
    winner_mount_id uuid,
    winner_logical_agent_id uuid
        REFERENCES control_plane.logical_agents(id) ON DELETE RESTRICT,
    winner_alias text
        CHECK (
            winner_alias IS NULL
            OR (
            length(winner_alias) BETWEEN 1 AND 32
            AND winner_alias !~ '[@\r\n]'
            )
        ),
    winner_pet_id text
        CHECK (
            winner_pet_id IS NULL
            OR (
            length(winner_pet_id) BETWEEN 1 AND 64
            AND winner_pet_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
            )
        ),
    winner_slacking_seconds bigint
        CHECK (
            winner_slacking_seconds IS NULL
            OR winner_slacking_seconds BETWEEN 1 AND 9007199254740991
        ),
    winner_score_reached_at timestamptz,
    settled_at timestamptz NOT NULL,
    PRIMARY KEY (office_id, office_local_date),
    FOREIGN KEY (office_id, schedule_version_id)
        REFERENCES control_plane.office_schedule_versions(office_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (office_id, winner_mount_id)
        REFERENCES control_plane.agent_office_mounts(office_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    CHECK (
        (
            outcome = 'no_award'
            AND winner_mount_id IS NULL
            AND winner_logical_agent_id IS NULL
            AND winner_alias IS NULL
            AND winner_pet_id IS NULL
            AND winner_slacking_seconds IS NULL
            AND winner_score_reached_at IS NULL
        )
        OR
        (
            outcome = 'winner'
            AND winner_mount_id IS NOT NULL
            AND winner_logical_agent_id IS NOT NULL
            AND winner_alias IS NOT NULL
            AND winner_pet_id IS NOT NULL
            AND winner_slacking_seconds IS NOT NULL
            AND winner_score_reached_at IS NOT NULL
        )
    )
);

CREATE INDEX office_day_results_latest
    ON control_plane.office_day_results (office_id, office_local_date DESC);

COMMENT ON TABLE control_plane.office_day_results IS
    'Immutable Office-wide settlement, including explicit no-award days. Public projection rechecks winner Mount stats consent and never reassigns a completed Award.';

ALTER TABLE control_plane.domain_outbox
    DROP CONSTRAINT domain_outbox_source_kind_check,
    ADD CONSTRAINT domain_outbox_source_kind_check
        CHECK (
            source_kind IN (
                'projection_seed',
                'edge_receipt',
                'lease_expiry',
                'consent_change',
                'schedule_change',
                'projection_tick',
                'office_day_settlement'
            )
        );

CREATE INDEX agent_office_mounts_by_agent_active
    ON control_plane.agent_office_mounts (logical_agent_id, office_id)
    WHERE active;

CREATE INDEX agent_office_mounts_public_presence
    ON control_plane.agent_office_mounts (office_id, id)
    WHERE active AND presence_visible;

CREATE INDEX agent_office_mounts_public_stats
    ON control_plane.agent_office_mounts (office_id, id)
    WHERE active AND stats_opt_in;

CREATE INDEX derived_activity_intervals_eligible_lookup
    ON control_plane.derived_activity_intervals
    (instance_id, started_at, ended_at)
    WHERE activity_state = 'eligible_idle';

CREATE FUNCTION control_plane.reject_immutable_public_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER office_revision_events_immutable
BEFORE UPDATE ON control_plane.office_revision_events
FOR EACH ROW EXECUTE FUNCTION control_plane.reject_immutable_public_update();

CREATE TRIGGER office_day_results_immutable
BEFORE UPDATE ON control_plane.office_day_results
FOR EACH ROW EXECUTE FUNCTION control_plane.reject_immutable_public_update();

CREATE TRIGGER office_schedule_versions_immutable
BEFORE UPDATE ON control_plane.office_schedule_versions
FOR EACH ROW EXECUTE FUNCTION control_plane.reject_immutable_public_update();

CREATE TRIGGER office_schedule_rules_immutable
BEFORE UPDATE ON control_plane.office_schedule_rules
FOR EACH ROW EXECUTE FUNCTION control_plane.reject_immutable_public_update();

ALTER TABLE control_plane.derived_activity_intervals
    ADD CONSTRAINT derived_activity_intervals_no_overlap
    EXCLUDE USING gist (
        instance_id WITH =,
        tstzrange(started_at, ended_at, '[)') WITH &&
    );

ALTER TABLE control_plane.mount_stats_eligibility_intervals
    ADD CONSTRAINT mount_stats_eligibility_intervals_no_overlap
    EXCLUDE USING gist (
        mount_id WITH =,
        tstzrange(started_at, ended_at, '[)') WITH &&
    );

ALTER TABLE control_plane.office_schedule_occurrences
    ADD CONSTRAINT office_schedule_occurrences_no_overlap
    EXCLUDE USING gist (
        office_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ),
    ADD CONSTRAINT office_schedule_occurrences_one_version_per_day
    EXCLUDE USING gist (
        office_id WITH =,
        office_local_date WITH =,
        schedule_version_id WITH <>
    );
