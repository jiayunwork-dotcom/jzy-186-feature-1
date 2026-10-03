import { Body, Controller, Module, Post, Get, Param } from '@nestjs/common';
import { EnergyMasterModule, EnergyMasterService } from '../master-data/energy-master.service';
import {
  EnergyFlowModule,
  EnergyFlowService,
  type EnergyOutputInput,
  type EnergyTransferInput
} from '../transfer/energy-flow.service';
import { LineageModule, LineageService } from '../lineage/lineage.service';
import { AccountingModule, AccountingService } from '../accounting/accounting.service';
import { CompanyModule, CompanyService } from '../company/company.service';
import { fracDto } from '../common/serialize';
import { type Gas } from '../factor-library/factor-library.service';

@Controller('master-data')
export class FacilityController {
  constructor(private readonly master: EnergyMasterService) {}

  @Post('facilities')
  upsertFacility(@Body() body: { code: string; siteCode: string; name: string }) {
    return this.master.upsertFacility(body).then(() => ({ ok: true }));
  }

  @Post('use-points')
  upsertUsePoint(
    @Body()
    body: {
      siteCode: string;
      code: string;
      name: string;
      facilityCode?: string | null;
    }
  ) {
    return this.master
      .upsertUsePoint({ ...body, facilityCode: body.facilityCode ?? null })
      .then(() => ({ ok: true }));
  }
}

@Controller('energy-outputs')
export class EnergyOutputController {
  constructor(private readonly flows: EnergyFlowService) {}

  /** Batch-register monthly facility production (per-record status report). */
  @Post('import')
  import(@Body() body: { records: EnergyOutputInput[] }) {
    return this.flows.bulkImportOutputs(body.records ?? []);
  }

  @Post('correct')
  correct(@Body() body: EnergyOutputInput) {
    return this.flows.correctOutput(body);
  }
}

@Controller('energy-transfers')
export class EnergyTransferController {
  constructor(private readonly flows: EnergyFlowService) {}

  /** Batch-register monthly internal transfers facility -> use point. */
  @Post('import')
  import(@Body() body: { records: EnergyTransferInput[] }) {
    return this.flows.bulkImportTransfers(body.records ?? []);
  }

  @Post('correct')
  correct(@Body() body: EnergyTransferInput) {
    return this.flows.correctTransfer(body);
  }
}

@Controller('accounting')
export class CompanyController {
  constructor(
    private readonly accounting: AccountingService,
    private readonly company: CompanyService,
    private readonly lineage: LineageService
  ) {}

  /**
   * Company consolidation: gross site sum, the internal-transfer elimination
   * and the net total, per site and overall.
   */
  @Post('company-report')
  async companyReport(
    @Body()
    body: {
      caliber: { cutId: number; factorVersionId: number; gwpSetId: number };
      filter?: { siteCode?: string; sourceCode?: string; month?: string; scope?: 1 | 2 };
    }
  ) {
    const bundle = await this.accounting.loadCaliber(body.caliber);
    const r = this.company.report(bundle, body.filter ?? {});
    const t = (x: (typeof r)['gross']) => ({
      co2Tonnes: fracDto(x.CO2),
      ch4Tonnes: fracDto(x.CH4),
      n2oTonnes: fracDto(x.N2O),
      co2eTonnes: fracDto(x.CO2E)
    });
    return {
      gross: t(r.gross),
      internalElimination: t(r.internalElimination),
      net: t(r.net),
      sites: r.sites.map((s) => ({
        siteCode: s.siteCode,
        gross: t(s.gross),
        transferredIn: t(s.transferredIn),
        net: t(s.net)
      }))
    };
  }

  /**
   * Forward trace of a receiver-side transfer scope-2 number to originating
   * fuel/purchase records, hop by hop with exact allocation proportions
   * (rings: one finite simple path per origin, exact share retained).
   */
  @Post('transfer-trace')
  async trace(
    @Body()
    body: {
      cutId: number;
      factorVersionId: number;
      gwpSetId: number;
      month: string;
      receiverSite: string;
      edgeRecordNo: string;
      gas: Gas;
    }
  ) {
    const r = await this.lineage.traceTransfer(body);
    return {
      ...r,
      gasTonnes: fracDto(r.gasTonnes),
      paths: r.paths.map((p) => ({
        ...p,
        exactShare: fracDto(p.exactShare),
        pathShare: fracDto(p.pathShare),
        circulationFactor: fracDto(p.circulationFactor),
        hops: p.hops.map((h) => ({ ...h, productShare: fracDto(h.productShare) }))
      }))
    };
  }

  /**
   * Reverse impact: closed snapshots that recomputed on the latest data would
   * change because of this record, including sites affected only via the
   * transfer chain. Snapshots themselves are never modified.
   */
  @Get('snapshot-impact/:recordNo')
  async impact(@Param('recordNo') recordNo: string) {
    const rows = await this.lineage.snapshotImpactOfRecord(recordNo);
    return rows.map((r) => ({
      ...r,
      changedRows: r.changedRows.map((c) => ({
        ...c,
        stored: fracDto(c.stored),
        recomputed: fracDto(c.recomputed),
        delta: fracDto(c.delta)
      }))
    }));
  }
}

@Module({
  imports: [
    EnergyMasterModule,
    EnergyFlowModule,
    LineageModule,
    AccountingModule,
    CompanyModule
  ],
  controllers: [FacilityController, EnergyOutputController, EnergyTransferController, CompanyController]
})
export class TransferApiModule {}
