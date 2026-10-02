-- Internal energy production & transfer (内部转供), migration 0002.
--
-- Design invariants carried over from migration 0001:
--  * every measured/computed value is an exact rational (num bigint, den bigint);
--  * outputs and transfers are immutable activity data with unique record
--    numbers and a single-level correction chain — exactly the same semantics
--    as activity_records (duplicate submission is idempotent, corrections
--    insert a new numbered row, a cut only sees rows created before as_of and
--    for which no successor is visible by then);
--  * this migration never touches pre-existing close data: snapshot tables
--    are extended additively and existing rows are merely *labelled*, their
--    stored numbers are not recomputed or rewritten.

-- ---------------------------------------------------------------------------
-- Production facilities (锅炉房、汽轮机…) and receiving energy points
-- ---------------------------------------------------------------------------

CREATE TABLE facilities (
    site_code   text NOT NULL REFERENCES sites(code),
    code        text NOT NULL,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_code, code)
);

-- A delivery point belongs to a site. When it is bound to a facility, energy
-- delivered to it is an *input* of that facility (it re-enters the allocation
-- pool); otherwise delivery is final energy use at that site (the embedded
-- emissions settle there as scope 2).
CREATE TABLE delivery_points (
    site_code      text NOT NULL REFERENCES sites(code),
    code           text NOT NULL,
    name           text NOT NULL,
    facility_code  text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_code, code),
    FOREIGN KEY (site_code, facility_code) REFERENCES facilities(site_code, code)
);

-- An emission source may belong to a production facility. The facility's
-- primary-input emissions (fuel combustion scope 1, purchased electricity
-- scope 2) are then exactly the evaluated leaves of its sources.
ALTER TABLE emission_sources
    ADD COLUMN facility_code text;
ALTER TABLE emission_sources
    ADD CONSTRAINT emission_sources_facility_fk
    FOREIGN KEY (site_code, facility_code) REFERENCES facilities(site_code, code);

-- Carriers of produced/transferred energy. Only carriers convertible to GJ
-- are allowed (units.ts knows the energy dimension).
DO $$ BEGIN
    CREATE TYPE energy_carrier AS ENUM ('STEAM', 'HOT_WATER', 'ELECTRICITY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Monthly energy outputs of a facility (per carrier)
-- ---------------------------------------------------------------------------

CREATE TABLE energy_outputs (
    id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    record_no             text NOT NULL UNIQUE,
    site_code             text NOT NULL,
    facility_code         text NOT NULL,
    month                 date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    carrier               energy_carrier NOT NULL,
    quantity_num          bigint NOT NULL,
    quantity_den          bigint NOT NULL CHECK (quantity_den > 0),
    unit                  text NOT NULL,
    is_correction         boolean NOT NULL DEFAULT false,
    supersedes_record_no  text REFERENCES energy_outputs(record_no),
    created_at            timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (site_code, facility_code) REFERENCES facilities(site_code, code),
    CHECK (quantity_num >= 0)
);

CREATE UNIQUE INDEX energy_outputs_one_correction_per_record
    ON energy_outputs (supersedes_record_no)
    WHERE supersedes_record_no IS NOT NULL;

-- At most one effective output per (facility, month, carrier). Correction
-- rows point at the same target, so the partial index covers the heads only
-- via the application (heads = no successor visible by the cut); this plain
-- unique index guards against two different records claiming the same
-- production slot inside a single import batch.
CREATE UNIQUE INDEX energy_outputs_slot
    ON energy_outputs (site_code, facility_code, month, carrier, supersedes_record_no);

CREATE INDEX energy_outputs_created ON energy_outputs (created_at);

-- ---------------------------------------------------------------------------
-- Monthly energy transfers facility -> (site, delivery point)
-- ---------------------------------------------------------------------------

CREATE TABLE energy_transfers (
    id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    record_no             text NOT NULL UNIQUE,
    from_site_code        text NOT NULL,
    from_facility_code    text NOT NULL,
    to_site_code          text NOT NULL,
    to_point_code         text NOT NULL,
    month                 date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    carrier               energy_carrier NOT NULL,
    quantity_num          bigint NOT NULL,
    quantity_den          bigint NOT NULL CHECK (quantity_den > 0),
    unit                  text NOT NULL,
    is_correction         boolean NOT NULL DEFAULT false,
    supersedes_record_no  text REFERENCES energy_transfers(record_no),
    created_at            timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (from_site_code, from_facility_code)
        REFERENCES facilities(site_code, code),
    FOREIGN KEY (to_site_code, to_point_code)
        REFERENCES delivery_points(site_code, code),
    CHECK (quantity_num >= 0)
);

CREATE UNIQUE INDEX energy_transfers_one_correction_per_record
    ON energy_transfers (supersedes_record_no)
    WHERE supersedes_record_no IS NOT NULL;

CREATE INDEX energy_transfers_created ON energy_transfers (created_at);

-- ---------------------------------------------------------------------------
-- Reference allocation efficiencies, published *with* a factor version.
-- Weight of carrier c for a facility producing outputs q is q/eta_c (the
-- "reference efficiency"/physical-content allocation). Defaults are applied
-- by the application when a version publishes no override, so every caliber
-- is still resolved against immutable versioned parameters.
-- ---------------------------------------------------------------------------

CREATE TABLE chp_reference_efficiencies (
    factor_version_id integer NOT NULL REFERENCES factor_versions(id) ON DELETE CASCADE,
    carrier           energy_carrier NOT NULL,
    eta_num           bigint NOT NULL,   -- dimensionless, > 0
    eta_den           bigint NOT NULL CHECK (eta_den > 0),
    PRIMARY KEY (factor_version_id, carrier),
    CHECK (eta_num > 0)
);

-- ---------------------------------------------------------------------------
-- Snapshot extensions (additive; pre-existing rows are labelled, not changed)
-- ---------------------------------------------------------------------------

-- Every snapshot row is either an evaluated activity leaf ('ACTIVITY') or an
-- internal-transfer scope-2 leaf at the receiving site ('TRANSFER').
ALTER TABLE snapshot_rows ADD COLUMN category text NOT NULL DEFAULT 'ACTIVITY';
ALTER TABLE snapshot_rows DROP CONSTRAINT snapshot_rows_pkey;
ALTER TABLE snapshot_rows ADD PRIMARY KEY
    (close_id, site_code, source_code, month, scope, gas, category);

-- Snapshot lineage: transfer leaves carry the allocation hops; activity rows
-- keep the factor reference. Both kinds coexist in one table: activity rows
-- (and every pre-existing row) use the sentinel upstream_record_no = ''
-- because they ARE primary rows; transfer rows name the upstream primary
-- activity record (the application resolves it from the immutable record set
-- at the close cut, so no FK is needed — a plain column also keeps historical
-- snapshots intact if records are ever archived). allocation_path records
-- every hop with its exact share; carrier is the transferred carrier. The
-- old lineage rows are only *labelled*, never rewritten.
ALTER TABLE snapshot_lineage
    ADD COLUMN category text NOT NULL DEFAULT 'ACTIVITY',
    ADD COLUMN carrier energy_carrier,
    ADD COLUMN upstream_record_no text NOT NULL DEFAULT '',
    ADD COLUMN allocation_path jsonb;
-- Transfer lineage rows have no factor of their own: the factor reference
-- lives on each upstream primary record. Existing rows keep their factor.
ALTER TABLE snapshot_lineage ALTER COLUMN factor_id DROP NOT NULL;

-- record_no historically referenced activity_records; with transfer lineage
-- rows it names an energy_transfers record instead. The reference is now
-- polymorphic by category and resolved by the application against the
-- immutable record set at the close cut, so the hard FK is dropped (old rows
-- and their referenced records are untouched).
ALTER TABLE snapshot_lineage DROP CONSTRAINT snapshot_lineage_record_no_fkey;

ALTER TABLE snapshot_lineage DROP CONSTRAINT snapshot_lineage_pkey;
ALTER TABLE snapshot_lineage ADD PRIMARY KEY
    (close_id, record_no, gas, category, upstream_record_no);
