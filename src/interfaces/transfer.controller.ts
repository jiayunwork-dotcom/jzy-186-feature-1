import { Body, Controller, Module, Post, Get, Param, Query } from '@nestjs/common';
import {
  TransferModule,
  TransferService
} from '../transfer/transfer.service';
import {
  TransferLineageModule,
  TransferLineageService,
  type TraceRequest
} from '../transfer/transfer-lineage.service';
import { MasterDataModule, MasterDataService } from '../master-data/master-data.service';
import {
  type EnergyOutputInput,
  type EnergyTransferInput
} from '../transfer/energy-records.service';
import { fracDto } from '../common/serialize';

// ---------------------------------------------------------------------------
// Master data: production facilities and delivery points
// ---------------------------------------------------------------------------

@Controller('master-data')
export class TransferMasterDataController {
  constructor(private readonly master: MasterDataService) {}

  @Post('facilities')
  upsertFacility(@Body() body: { siteCode: string; code: string; name: string }) {
    return this.master.upsertFacility(body).then(() => ({ ok: true }));
  }

  @Post('delivery-points')
  upsertDeliveryPoint(
    @Body()
    body: { siteCode: string; code: string; name: string; facilityCode?: string | null }
  ) {
    return this.master.upsertDeliveryPoint(body).then(() => ({ ok: true }));
  }
}

// ---------------------------------------------------------------------------
// Energy outputs and internal transfers
// ---------------------------------------------------------------------------

@Controller('energy')
export class EnergyController {
  constructor(private readonly transfers: TransferService) {}

  /** Batch import monthly facility outputs (same per-record semantics as activity import). */
  @Post('outputs/import')
  importOutputs(@Body() body: { outputs: EnergyOutputInput[] }) {
    return this.transfers.importOutputs(body.outputs ?? []);
  }

  /** Batch import internal energy transfers. */
  @Post('transfers/import')
  importTransfers(@Body() body: { transfers: EnergyTransferInput[] }) {
    return this.transfers.importTransfers(body.transfers ?? []);
  }
}

// ---------------------------------------------------------------------------
// Transfer lineage: forward trace and reverse impact
// ---------------------------------------------------------------------------

@Controller('transfer-lineage')
export class TransferLineageController {
  constructor(private readonly lineage: TransferLineageService) {}

  /** Trace a receiver-side transfer scope-2 number back to primary records. */
  @Post('trace')
  async trace(@Body() body: TraceRequest) {
    const r = await this.lineage.trace(body);
    return {
      transferRecordNo: r.transferRecordNo,
      contributions: r.contributions.map((c) => ({
        upstreamRecordNo: c.upstreamRecordNo,
        producerFacility: c.producerFacility,
        carrier: c.carrier,
        share: fracDto(c.share),
        gasTonnes: {
          CO2: fracDto(c.gasTonnes.CO2),
          CH4: fracDto(c.gasTonnes.CH4),
          N2O: fracDto(c.gasTonnes.N2O)
        },
        factorIdByGas: c.factorIdByGas,
        hop: {
          ...c.hop,
          hopShare: fracDto(c.hop.hopShare)
        }
      }))
    };
  }

  /**
   * Reverse impact: which closed snapshots would change under latest data
   * after a record (activity / output / transfer) is corrected.
   */
  @Get('impact/:recordNo')
  async impact(
    @Param('recordNo') recordNo: string,
    @Query('factorVersionId') factorVersionId?: string,
    @Query('gwpSetId') gwpSetId?: string
  ) {
    const r = await this.lineage.impactOfRecord(recordNo, {
      factorVersionId: factorVersionId ? parseInt(factorVersionId, 10) : undefined,
      gwpSetId: gwpSetId ? parseInt(gwpSetId, 10) : undefined
    });
    return {
      recordNo: r.recordNo,
      kind: r.kind,
      impacted: r.impacted.map((s) => ({
        closeId: s.closeId,
        month: s.month,
        isCompanyWide: s.isCompanyWide,
        siteCode: s.siteCode,
        propagationPath: s.propagationPath,
        viaTransfer: s.viaTransfer,
        delta: {
          co2Tonnes: fracDto(s.delta.CO2),
          ch4Tonnes: fracDto(s.delta.CH4),
          n2oTonnes: fracDto(s.delta.N2O),
          co2eTonnes: fracDto(s.delta.CO2E)
        }
      }))
    };
  }
}

@Module({
  imports: [TransferModule, TransferLineageModule, MasterDataModule],
  controllers: [TransferMasterDataController, EnergyController, TransferLineageController]
})
export class TransferApiModule {}
