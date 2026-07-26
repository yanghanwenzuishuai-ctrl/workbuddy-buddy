CREATE TABLE control_plane.server_identity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    server_id uuid NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO control_plane.server_identity (singleton, server_id)
VALUES (
    true,
    md5(
        clock_timestamp()::text
        || ':' || random()::text
        || ':' || pg_backend_pid()::text
    )::uuid
);

ALTER TABLE control_plane.logical_agents
    ADD CONSTRAINT logical_agents_id_owner_unique
        UNIQUE (id, owner_account_id);

ALTER TABLE control_plane.agent_office_mounts
    ADD COLUMN owner_account_id uuid;

UPDATE control_plane.agent_office_mounts mount
   SET owner_account_id = agent.owner_account_id
  FROM control_plane.logical_agents agent
 WHERE agent.id = mount.logical_agent_id;

INSERT INTO control_plane.memberships (
    id, office_id, account_id, created_at
)
SELECT
    md5(mount.office_id::text || ':' || mount.owner_account_id::text)::uuid,
    mount.office_id,
    mount.owner_account_id,
    MIN(mount.activated_at)
FROM control_plane.agent_office_mounts mount
GROUP BY mount.office_id, mount.owner_account_id
ON CONFLICT (office_id, account_id) DO NOTHING;

ALTER TABLE control_plane.agent_office_mounts
    ALTER COLUMN owner_account_id SET NOT NULL,
    ADD CONSTRAINT agent_office_mounts_identity_unique
        UNIQUE (office_id, id, logical_agent_id, owner_account_id),
    ADD CONSTRAINT agent_office_mounts_agent_owner_fk
        FOREIGN KEY (logical_agent_id, owner_account_id)
        REFERENCES control_plane.logical_agents(id, owner_account_id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION control_plane.enforce_mount_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected_owner uuid;
BEGIN
    SELECT owner_account_id
      INTO expected_owner
      FROM control_plane.logical_agents
     WHERE id = NEW.logical_agent_id;

    IF expected_owner IS NULL THEN
        RAISE EXCEPTION 'logical Agent does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF NEW.owner_account_id IS NULL THEN
        NEW.owner_account_id := expected_owner;
    ELSIF NEW.owner_account_id <> expected_owner THEN
        RAISE EXCEPTION 'Mount owner does not own logical Agent'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.active AND NOT EXISTS (
        SELECT 1
          FROM control_plane.memberships membership
         WHERE membership.office_id = NEW.office_id
           AND membership.account_id = NEW.owner_account_id
    ) THEN
        RAISE EXCEPTION 'active Mount owner must be an Office member'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER agent_office_mounts_owner_membership
BEFORE INSERT OR UPDATE OF
    office_id, logical_agent_id, owner_account_id, active
ON control_plane.agent_office_mounts
FOR EACH ROW EXECUTE FUNCTION control_plane.enforce_mount_owner_membership();

CREATE FUNCTION control_plane.reject_membership_removal_with_active_mounts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM control_plane.agent_office_mounts mount
         WHERE mount.office_id = OLD.office_id
           AND mount.owner_account_id = OLD.account_id
           AND mount.active
    ) THEN
        RAISE EXCEPTION 'deactivate Office Mounts before removing membership'
            USING ERRCODE = '23503';
    END IF;
    RETURN OLD;
END;
$$;

CREATE CONSTRAINT TRIGGER memberships_no_active_mounts
AFTER DELETE ON control_plane.memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
    control_plane.reject_membership_removal_with_active_mounts();

ALTER TABLE control_plane.device_credentials
    ADD CONSTRAINT device_credentials_public_key_unique UNIQUE (public_key);

CREATE TABLE control_plane.onboarding_pairings (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL
        REFERENCES control_plane.accounts(id) ON DELETE CASCADE,
    office_id uuid NOT NULL
        REFERENCES control_plane.offices(id) ON DELETE CASCADE,
    logical_agent_id uuid NOT NULL
        REFERENCES control_plane.logical_agents(id) ON DELETE CASCADE,
    mount_id uuid NOT NULL,
    pairing_code_hash bytea NOT NULL UNIQUE
        CHECK (octet_length(pairing_code_hash) = 32),
    status_secret_hash bytea NOT NULL UNIQUE
        CHECK (octet_length(status_secret_hash) = 32),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'claimed')),
    failed_claim_attempts smallint NOT NULL DEFAULT 0
        CHECK (failed_claim_attempts BETWEEN 0 AND 32),
    claimed_public_key_hash bytea
        CHECK (
            claimed_public_key_hash IS NULL
            OR octet_length(claimed_public_key_hash) = 32
    ),
    claimed_instance_id uuid
        REFERENCES control_plane.agent_instances(id) ON DELETE CASCADE,
    claimed_key_id uuid
        REFERENCES control_plane.device_credentials(key_id) ON DELETE CASCADE,
    claimed_client_version text
        CHECK (
            claimed_client_version IS NULL
            OR length(claimed_client_version) BETWEEN 5 AND 64
        ),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    claimed_at timestamptz,
    UNIQUE (office_id),
    UNIQUE (logical_agent_id),
    FOREIGN KEY (office_id, account_id)
        REFERENCES control_plane.memberships(office_id, account_id)
        ON DELETE CASCADE,
    FOREIGN KEY (logical_agent_id, account_id)
        REFERENCES control_plane.logical_agents(id, owner_account_id)
        ON DELETE CASCADE,
    FOREIGN KEY (
        office_id, mount_id, logical_agent_id, account_id
    )
        REFERENCES control_plane.agent_office_mounts(
            office_id, id, logical_agent_id, owner_account_id
        )
        ON DELETE CASCADE,
    CHECK (expires_at > created_at),
    CHECK (
        (
            status = 'pending'
            AND claimed_public_key_hash IS NULL
            AND claimed_instance_id IS NULL
            AND claimed_key_id IS NULL
            AND claimed_client_version IS NULL
            AND claimed_at IS NULL
        )
        OR
        (
            status = 'claimed'
            AND claimed_public_key_hash IS NOT NULL
            AND claimed_instance_id IS NOT NULL
            AND claimed_key_id IS NOT NULL
            AND claimed_client_version IS NOT NULL
            AND claimed_at IS NOT NULL
        )
    )
);

CREATE INDEX onboarding_pairings_expiry
    ON control_plane.onboarding_pairings (expires_at)
    WHERE status = 'pending';

CREATE TABLE control_plane.edge_report_rate_limits (
    instance_id uuid PRIMARY KEY
        REFERENCES control_plane.agent_instances(id) ON DELETE CASCADE,
    window_started_at timestamptz NOT NULL,
    report_count integer NOT NULL DEFAULT 0
        CHECK (report_count BETWEEN 0 AND 1000000),
    event_count integer NOT NULL DEFAULT 0
        CHECK (event_count BETWEEN 0 AND 1000000),
    updated_at timestamptz NOT NULL
);

CREATE TABLE control_plane.onboarding_ip_rate_limits (
    ip_hash bytea PRIMARY KEY CHECK (octet_length(ip_hash) = 32),
    window_started_at timestamptz NOT NULL,
    office_create_count integer NOT NULL DEFAULT 0
        CHECK (office_create_count BETWEEN 0 AND 1000000),
    claim_count integer NOT NULL DEFAULT 0
        CHECK (claim_count BETWEEN 0 AND 1000000),
    poll_count integer NOT NULL DEFAULT 0
        CHECK (poll_count BETWEEN 0 AND 1000000),
    updated_at timestamptz NOT NULL
);

COMMENT ON TABLE control_plane.onboarding_pairings IS
    'Five-minute, single-claim onboarding capabilities. Only SHA-256 capability digests are persisted.';

COMMENT ON COLUMN control_plane.onboarding_pairings.status_secret_hash IS
    'SHA-256 of the browser polling capability. The raw status token is never persisted.';

COMMENT ON COLUMN control_plane.edge_report_receipts.canonical_payload IS
    'Canonical bytes retained only for exact replay while a boot is current. Fenced-boot receipts are deleted.';
