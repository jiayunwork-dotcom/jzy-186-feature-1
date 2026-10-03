import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService, type Queryer } from '../database/database.module';

export interface Facility {
  code: string;
  siteCode: string;
  name: string;
}

export interface EnergyUsePoint {
  siteCode: string;
  code: string;
  name: string;
  /** Set when deliveries here feed another facility; NULL = final use. */
  facilityCode: string | null;
}

/**
 * Producing facilities (锅炉房 / 汽轮机 …) and site-internal energy delivery
 * points (用能点). A facility belongs to exactly one site; a use point may
 * itself be the inlet of another facility, which is exactly what lets the
 * transfer graph model the "electricity flows back to the boiler house" ring.
 */
@Injectable()
export class EnergyMasterService {
  constructor(private readonly db: DbService) {}

  async upsertFacility(f: Facility): Promise<void> {
    await this.db.query(
      `INSERT INTO facilities(code, site_code, name) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE
         SET site_code = EXCLUDED.site_code, name = EXCLUDED.name`,
      [f.code, f.siteCode, f.name]
    );
  }

  async getFacility(code: string): Promise<Facility | null> {
    return this.getFacilityOn(this.db, code);
  }

  async getFacilityOn(client: Queryer, code: string): Promise<Facility | null> {
    const res = await client.query<{ code: string; site_code: string; name: string }>(
      'SELECT code, site_code, name FROM facilities WHERE code = $1',
      [code]
    );
    const r = res.rows[0];
    return r ? { code: r.code, siteCode: r.site_code, name: r.name } : null;
  }

  async upsertUsePoint(p: EnergyUsePoint): Promise<void> {
    await this.db.query(
      `INSERT INTO energy_use_points(site_code, code, name, facility_code)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (site_code, code) DO UPDATE
         SET name = EXCLUDED.name, facility_code = EXCLUDED.facility_code`,
      [p.siteCode, p.code, p.name, p.facilityCode ?? null]
    );
  }

  async getUsePointOn(
    client: Queryer,
    siteCode: string,
    code: string
  ): Promise<EnergyUsePoint | null> {
    const res = await client.query<{
      site_code: string;
      code: string;
      name: string;
      facility_code: string | null;
    }>(
      `SELECT site_code, code, name, facility_code
       FROM energy_use_points WHERE site_code = $1 AND code = $2`,
      [siteCode, code]
    );
    const r = res.rows[0];
    return r
      ? { siteCode: r.site_code, code: r.code, name: r.name, facilityCode: r.facility_code }
      : null;
  }
}

@Module({
  imports: [DbModule],
  providers: [EnergyMasterService],
  exports: [EnergyMasterService]
})
export class EnergyMasterModule {}
