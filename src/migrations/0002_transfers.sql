-- Internal energy transfer support (east plant <-> west plant steam / electricity).
--
-- Design sketch (see README section 9 for the full rationale):
--
--   * facilities            产能设施 (boiler house, turbine, ...), each belongs
--                           to exactly one site.
--   * emission_sources gains facility_code: an activity record registered on a
--                           facility-linked source is an *input* of that
--                           facility (fuel burnt, purchased electricity used,
--                           ...). Sources without facility_code stay exactly
--                           what they were today: direct, terminal leaves.
--   * energy_use_points     delivery points inside a site ("哪个用能点"); a
--                           delivery point may itself feed another facility
--                           (facility_code set) or be final use (NULL).
--   * carrier_efficiencies  reference-efficiency allocation parameters,
--                           published *together with a factor version*, one
--                           per energy carrier (steam / electricity / hot
--                           water / ...).
--   * energy_outputs        monthly production of a facility, per carrier,
--                           with the same unique-no + correction-chain
--                           discipline as activity_records.
--   * energy_transfers      monthly amounts handed from a facility to a use
--                           point of (possibly) another site — same discipline.
--
-- Every measured value keeps the exact (num, den) bigint rational storage
-- convention; SQL never sums accounting values.

-- ---------------------------------------------------------------------------
-- Producing facilities
-- ---------------------------------------------------------------------------

CREATE TABLE facilities (
    code        text PRIMARY KEY,
    site_code   text NOT NULL REFERENCES sites(code),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- An emission source may be attached to a facility: activity on such a source
-- is an *input* of the facility (fuel combusted there, purchased electricity
-- consumed there) and feeds the transfer allocation instead of being a
-- terminal leaf. NULL = pre-existing behaviour, terminal direct use.
ALTER TABLE emission_sources
    ADD COLUMN facility_code text REFERENCES facilities(code);

CREATE INDEX emission_sources_facility ON emission_sources(facility_code);

-- A facility must be registered on the same site as its sources.
CREATE OR REPLACE FUNCTION emission_source_facility_site_check()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.facility_code IS NOT NULL THEN
        PERFORM 1 FROM facilities f
         WHERE f.code = NEW.facility_code AND f.site_code = NEW.site_code;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'facility % is not registered on site %',
                NEW.facility_code, NEW.site_code
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER emission_source_facility_site_trg
    BEFORE INSERT OR UPDATE ON emission_sources
    FOR EACH ROW EXECUTE FUNCTION emission_source_facility_site_check();

-- ---------------------------------------------------------------------------
-- Energy delivery points ("用能点")
-- ---------------------------------------------------------------------------

CREATE TABLE energy_use_points (
    site_code      text NOT NULL REFERENCES sites(code),
    code           text NOT NULL,
    name           text NOT NULL,
    -- When set, energy delivered here is an *input* of that facility (the
    -- point is e.g. the turbine's steam inlet). NULL = final use at the site.
    facility_code  text REFERENCES facilities(code),
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_code, code)
);

CREATE INDEX energy_use_points_facility ON energy_use_points(facility_code);

-- ---------------------------------------------------------------------------
-- Carrier reference efficiencies, versioned with the factor library
-- ---------------------------------------------------------------------------

CREATE TABLE carrier_efficiencies (
    factor_version_id integer NOT NULL REFERENCES factor_versions(id) ON DELETE CASCADE,
    carrier           text NOT NULL,        -- steam / electricity / hot_water / ...
    ref_eff_num       bigint NOT NULL,      -- dimensionless reference efficiency (0,1]
    ref_eff_den       bigint NOT NULL CHECK (ref_eff_den > 0),
    PRIMARY KEY (factor_version_id, carrier),
    CHECK (ref_eff_num > 0 AND ref_eff_num <= ref_eff_den)
);

-- ---------------------------------------------------------------------------
-- Monthly facility outputs (production), correction-chain discipline identical
-- to activity_records.
-- ---------------------------------------------------------------------------

CREATE TABLE energy_outputs (
    id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    record_no             text NOT NULL UNIQUE,
    facility_code         text NOT NULL REFERENCES facilities(code),
    month                 date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    carrier               text NOT NULL,
    quantity_num          bigint NOT NULL,   -- energy content, canonical unit GJ
    quantity_den          bigint NOT NULL CHECK (quantity_den > 0),
    unit                  text NOT NULL,     -- declared unit (must convert to GJ)
    is_correction         boolean NOT NULL DEFAULT false,
    supersedes_record_no  text REFERENCES energy_outputs(record_no),
    created_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (quantity_num > 0)
);

CREATE UNIQUE INDEX energy_outputs_one_correction_per_record
    ON energy_outputs (supersedes_record_no)
    WHERE supersedes_record_no IS NOT NULL;

CREATE INDEX energy_outputs_lookup
    ON energy_outputs (facility_code, month, carrier);
CREATE INDEX energy_outputs_created
    ON energy_outputs (created_at);

-- ---------------------------------------------------------------------------
-- Monthly internal transfers facility -> use point, same discipline.
-- ---------------------------------------------------------------------------

CREATE TABLE energy_transfers (
    id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    record_no             text NOT NULL UNIQUE,
    facility_code         text NOT NULL REFERENCES facilities(code),
    month                 date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    carrier               text NOT NULL,
    quantity_num          bigint NOT NULL,
    quantity_den          bigint NOT NULL CHECK (quantity_den > 0),
    unit                  text NOT NULL,
    to_site_code          text NOT NULL,
    to_use_point_code     text NOT NULL,
    is_correction         boolean NOT NULL DEFAULT false,
    supersedes_record_no  text REFERENCES energy_transfers(record_no),
    created_at            timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (to_site_code, to_use_point_code)
        REFERENCES energy_use_points(site_code, code),
    CHECK (quantity_num > 0)
);

CREATE UNIQUE INDEX energy_transfers_one_correction_per_record
    ON energy_transfers (supersedes_record_no)
    WHERE supersedes_record_no IS NOT NULL;

CREATE INDEX energy_transfers_from
    ON energy_transfers (facility_code, month, carrier);
CREATE INDEX energy_transfers_to
    ON energy_transfers (to_site_code, to_use_point_code, month, carrier);
CREATE INDEX energy_transfers_created
    ON energy_transfers (created_at);

-- ---------------------------------------------------------------------------
-- Snapshot extension. The original snapshot_rows primary key gains a
-- `category` column:
--   * pre-existing rows are stamped 'DIRECT' (migration fills the default),
--     so every old snapshot keeps exactly its former rows and values;
--   * transfer-allocated scope-2 rows are stamped 'TRANSFER'; the wider key
--     is what allows DIRECT and TRANSFER scope-2 of the same point to coexist.
-- Nothing stored here is ever recomputed.
-- ---------------------------------------------------------------------------

ALTER TABLE snapshot_rows ADD COLUMN category text NOT NULL DEFAULT 'DIRECT';

ALTER TABLE snapshot_rows DROP CONSTRAINT snapshot_rows_pkey;
ALTER TABLE snapshot_rows
    ADD CONSTRAINT snapshot_rows_pkey
    PRIMARY KEY (close_id, site_code, source_code, month, scope, gas, category);

-- Materialized transfer lineage for snapshots taken after this migration.
-- One row per transfer edge, gas and *originating* record/factor; the share
-- is the exact rational fraction of that origin's gas mass carried by the
-- edge at the close caliber. Old snapshots simply have no rows here, and
-- their old snapshot_lineage content is untouched.
CREATE TABLE snapshot_transfer_lineage (
    close_id            integer NOT NULL REFERENCES close_periods(id) ON DELETE CASCADE,
    month               date NOT NULL,
    edge_from_facility  text NOT NULL,
    edge_to_site        text NOT NULL,
    edge_to_use_point   text NOT NULL,
    carrier             text NOT NULL,
    gas                 text NOT NULL CHECK (gas IN ('CO2', 'CH4', 'N2O')),
    origin_record_no    text NOT NULL,
    origin_factor_id    integer NOT NULL,
    share_num           bigint NOT NULL,
    share_den           bigint NOT NULL CHECK (share_den > 0),
    gas_mass_num        bigint NOT NULL,
    gas_mass_den        bigint NOT NULL,
    PRIMARY KEY (close_id, month, edge_from_facility, edge_to_site,
                 edge_to_use_point, carrier, gas, origin_record_no,
                 origin_factor_id)
);

CREATE INDEX snapshot_transfer_lineage_close
    ON snapshot_transfer_lineage(close_id);
