import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService, type Queryer } from '../database/database.module';
import { NotFoundError, ValidationException } from '../common/errors';

export interface Site {
  code: string;
  name: string;
}

export interface EmissionSource {
  siteCode: string;
  code: string;
  name: string;
  /** Fuel / activity key matched against the factor library. */
  fuelKey: string;
  scope: 1 | 2;
  /** Production facility this source's activity is an input of, if any. */
  facilityCode?: string | null;
}

export interface Facility {
  siteCode: string;
  code: string;
  name: string;
}

export interface DeliveryPoint {
  siteCode: string;
  code: string;
  name: string;
  /**
   * When set, energy delivered to this point is an input of this facility
   * (re-enters the allocation pool); when null the delivery is final energy
   * use at the site and emissions settle there.
   */
  facilityCode?: string | null;
}

@Injectable()
export class MasterDataService {
  constructor(private readonly db: DbService) {}

  async upsertSite(site: Site): Promise<void> {
    await this.db.query(
      `INSERT INTO sites(code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
      [site.code, site.name]
    );
  }

  async upsertSource(source: EmissionSource): Promise<void> {
    await this.upsertSite({ code: source.siteCode, name: source.siteCode });
    if (source.facilityCode) {
      const f = await this.getFacility(source.siteCode, source.facilityCode);
      if (!f) {
        throw new ValidationException([
          {
            field: 'facilityCode',
            code: 'NOT_FOUND',
            message: `facility ${source.siteCode}/${source.facilityCode} is not registered`
          }
        ]);
      }
    }
    await this.db.query(
      `INSERT INTO emission_sources(site_code, code, name, fuel_key, scope, facility_code)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (site_code, code)
       DO UPDATE SET name = EXCLUDED.name, fuel_key = EXCLUDED.fuel_key,
                     scope = EXCLUDED.scope, facility_code = EXCLUDED.facility_code`,
      [
        source.siteCode,
        source.code,
        source.name,
        source.fuelKey,
        source.scope,
        source.facilityCode ?? null
      ]
    );
  }

  async getSource(siteCode: string, code: string): Promise<EmissionSource | null> {
    const res = await this.db.query<{
      site_code: string;
      code: string;
      name: string;
      fuel_key: string;
      scope: number;
      facility_code: string | null;
    }>(
      `SELECT site_code, code, name, fuel_key, scope, facility_code
       FROM emission_sources WHERE site_code = $1 AND code = $2`,
      [siteCode, code]
    );
    const r = res.rows[0];
    return r
      ? {
          siteCode: r.site_code,
          code: r.code,
          name: r.name,
          fuelKey: r.fuel_key,
          scope: r.scope as 1 | 2,
          facilityCode: r.facility_code
        }
      : null;
  }

  /** Load all sources (used by caliber bundle resolution). */
  async getAllSourcesOn(client: Queryer): Promise<EmissionSource[]> {
    const res = await client.query<{
      site_code: string;
      code: string;
      name: string;
      fuel_key: string;
      scope: number;
      facility_code: string | null;
    }>(`SELECT site_code, code, name, fuel_key, scope, facility_code
        FROM emission_sources`);
    return res.rows.map((r) => ({
      siteCode: r.site_code,
      code: r.code,
      name: r.name,
      fuelKey: r.fuel_key,
      scope: r.scope as 1 | 2,
      facilityCode: r.facility_code
    }));
  }

  // --------------------------------------------------------------------------
  // Production facilities and delivery points (内部转供主数据)
  // --------------------------------------------------------------------------

  async upsertFacility(facility: Facility): Promise<void> {
    await this.upsertSite({ code: facility.siteCode, name: facility.siteCode });
    await this.db.query(
      `INSERT INTO facilities(site_code, code, name) VALUES ($1, $2, $3)
       ON CONFLICT (site_code, code) DO UPDATE SET name = EXCLUDED.name`,
      [facility.siteCode, facility.code, facility.name]
    );
  }

  async getFacility(siteCode: string, code: string): Promise<Facility | null> {
    return this.getFacilityOn(this.db, siteCode, code);
  }

  async getFacilityOn(client: Queryer, siteCode: string, code: string): Promise<Facility | null> {
    const res = await client.query<{ site_code: string; code: string; name: string }>(
      'SELECT site_code, code, name FROM facilities WHERE site_code = $1 AND code = $2',
      [siteCode, code]
    );
    const r = res.rows[0];
    return r ? { siteCode: r.site_code, code: r.code, name: r.name } : null;
  }

  async getAllFacilitiesOn(client: Queryer): Promise<Facility[]> {
    const res = await client.query<{ site_code: string; code: string; name: string }>(
      'SELECT site_code, code, name FROM facilities ORDER BY site_code, code'
    );
    return res.rows.map((r) => ({ siteCode: r.site_code, code: r.code, name: r.name }));
  }

  async upsertDeliveryPoint(point: DeliveryPoint): Promise<void> {
    await this.upsertSite({ code: point.siteCode, name: point.siteCode });
    if (point.facilityCode) {
      const f = await this.getFacility(point.siteCode, point.facilityCode);
      if (!f) {
        throw new NotFoundError(
          `facility ${point.siteCode}/${point.facilityCode} is not registered; cannot bind delivery point`
        );
      }
    }
    await this.db.query(
      `INSERT INTO delivery_points(site_code, code, name, facility_code)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (site_code, code)
       DO UPDATE SET name = EXCLUDED.name, facility_code = EXCLUDED.facility_code`,
      [point.siteCode, point.code, point.name, point.facilityCode ?? null]
    );
  }

  async getDeliveryPointOn(
    client: Queryer,
    siteCode: string,
    code: string
  ): Promise<DeliveryPoint | null> {
    const res = await client.query<{
      site_code: string;
      code: string;
      name: string;
      facility_code: string | null;
    }>(
      `SELECT site_code, code, name, facility_code
       FROM delivery_points WHERE site_code = $1 AND code = $2`,
      [siteCode, code]
    );
    const r = res.rows[0];
    return r
      ? { siteCode: r.site_code, code: r.code, name: r.name, facilityCode: r.facility_code }
      : null;
  }

  async getAllDeliveryPointsOn(client: Queryer): Promise<DeliveryPoint[]> {
    const res = await client.query<{
      site_code: string;
      code: string;
      name: string;
      facility_code: string | null;
    }>(
      `SELECT site_code, code, name, facility_code
       FROM delivery_points ORDER BY site_code, code`
    );
    return res.rows.map((r) => ({
      siteCode: r.site_code,
      code: r.code,
      name: r.name,
      facilityCode: r.facility_code

    }));
  }
}

@Module({
  imports: [DbModule],
  providers: [MasterDataService],
  exports: [MasterDataService]
})
export class MasterDataModule {}
