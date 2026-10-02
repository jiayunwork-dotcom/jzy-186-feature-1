import { Body, Controller, Module, Post } from '@nestjs/common';
import {
  AccountingModule,
  AccountingService
} from '../accounting/accounting.service';
import { totalsDto } from '../common/serialize';
import type { AggregateQuery, Caliber, DimensionKey } from '../accounting/engine';

interface SummaryRequest {
  caliber: Caliber;
  groupBy?: DimensionKey[];
  filter?: Omit<AggregateQuery, 'groupBy'>;
  /**
   * 'site' (default): site view, transfer scope 2 counted at the receiver.
   * 'company': company view — gross site sum, internal-transfer elimination
   * (per gas and CO2e), and net company total.
   */
  view?: 'site' | 'company';
}

@Controller('accounting')
export class SummaryController {
  constructor(private readonly accounting: AccountingService) {}

  /**
   * On-demand summary by caliber. The same caliber always returns identical
   * values: it is recomputed from immutable cut/version/GWP objects with
   * exact rationals in fixed summation order.
   */
  @Post('summary')
  async summary(@Body() body: SummaryRequest) {
    const bundle = await this.accounting.loadCaliber(body.caliber);
    const query: AggregateQuery = { ...(body.filter ?? {}), groupBy: body.groupBy ?? ['site', 'source', 'month'] };
    const rows = this.accounting.aggregate(bundle, query);
    if (body.view === 'company') {
      const { grossTotal, elimination, netTotal } = this.accounting.companyTotals(
        bundle,
        body.filter ?? {}
      );
      return {
        view: 'company' as const,
        caliber: {
          ...body.caliber,
          cutAsOf: bundle.asOf,
          factorVersion: bundle.factorVersion,
          gwpSetCode: bundle.gwpSetCode
        },
        rows: rows.map((r) => ({
          siteCode: r.siteCode,
          sourceCode: r.sourceCode,
          month: r.month,
          scope: r.scope,
          category: r.category,
          totals: totalsDto(r.totals)
        })),
        grossTotal: totalsDto(grossTotal),
        elimination: totalsDto(elimination),
        netTotal: totalsDto(netTotal)
      };
    }
    return {
      view: 'site' as const,
      caliber: {
        ...body.caliber,
        cutAsOf: bundle.asOf,
        factorVersion: bundle.factorVersion,
        gwpSetCode: bundle.gwpSetCode
      },
      rows: rows.map((r) => ({
        siteCode: r.siteCode,
        sourceCode: r.sourceCode,
        month: r.month,
        scope: r.scope,
        category: r.category,
        totals: totalsDto(r.totals)
      })),
      grandTotal: totalsDto(this.accounting.grandTotal(bundle, body.filter ?? {}))
    };
  }
}

@Module({
  imports: [AccountingModule],
  controllers: [SummaryController]
})
export class SummaryApiModule {}
