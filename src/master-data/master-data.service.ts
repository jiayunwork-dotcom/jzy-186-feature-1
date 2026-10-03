import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService } from '../database/database.module';

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
  /** When set, activity on this source is an input of that facility. */
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
    await this.db.query(
      `INSERT INTO emission_sources(site_code, code, name, fuel_key, scope, facility_code)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (site_code, code)
       DO UPDATE SET name = EXCLUDED.name, fuel_key = EXCLUDED.fuel_key,
                     scope = EXCLUDED.scope, facility_code = EXCLUDED.facility_code`,
      [source.siteCode, source.code, source.name, source.fuelKey, source.scope, source.facilityCode ?? null]
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
}

@Module({
  imports: [DbModule],
  providers: [MasterDataService],
  exports: [MasterDataService]
})
export class MasterDataModule {}
