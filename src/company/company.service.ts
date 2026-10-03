import { Injectable, Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.service';
import type { CaliberBundle } from '../accounting/accounting.service';
import {
  type AccountingLeaf,
  type AggregateQuery,
  type GasTotals
} from '../accounting/engine';
import { Fraction } from '../common/fraction';
import { GASES } from '../factor-library/factor-library.service';

export interface SiteCompanyRow {
  siteCode: string;
  /** Site-view total (its scope 1/2 including received internal transfers). */
  gross: GasTotals;
  /** Scope-2 energy received via internal transfers (eliminated at company). */
  transferredIn: GasTotals;
  /** Gross minus transferred-in: this site's net contribution. */
  net: GasTotals;
}

export interface CompanyReport {
  /** Sum of all site views, before internal elimination. */
  gross: GasTotals;
  /** Internal transfer emissions removed by consolidation (>= 0). */
  internalElimination: GasTotals;
  /** After elimination: each fuel's combustion counted exactly once. */
  net: GasTotals;
  sites: SiteCompanyRow[];
}

function zeroTotals(): GasTotals {
  return { CO2: Fraction.ZERO, CH4: Fraction.ZERO, N2O: Fraction.ZERO, CO2E: Fraction.ZERO };
}

/**
 * Company view vs site view.
 *
 * Site views keep the mirror accounting: the producer site keeps the full
 * scope-1 combustion and every receiving site additionally books the
 * transferred energy as scope 2 (category TRANSFER). Summing site views
 * therefore counts internal energy twice; the company consolidation
 * subtracts *exactly* the internal-transfer scope-2 rows, leaving the
 * original combustion once. The report exposes all three numbers so the
 * difference is visible, not hidden.
 *
 * Changing only transfer amounts (fuel and purchased electricity untouched)
 * moves emissions between sites and changes gross, but the elimination moves
 * by the same amount and net is bit-for-bit unchanged.
 */
@Injectable()
export class CompanyService {
  constructor() {}

  report(bundle: CaliberBundle, query: AggregateQuery = {}): CompanyReport {
    const leaves = bundle.leaves.filter((l) => {
      if (query.siteCode && l.siteCode !== query.siteCode) return false;
      if (query.sourceCode && l.sourceCode !== query.sourceCode) return false;
      if (query.month && l.month !== query.month) return false;
      if (query.scope && l.scope !== query.scope) return false;
      return true;
    });

    const sites = new Set(leaves.map((l) => l.siteCode));
    const rows: SiteCompanyRow[] = [];
    for (const siteCode of [...sites].sort()) {
      const gross = zeroTotals();
      const transferredIn = zeroTotals();
      for (const l of leaves.filter((x) => x.siteCode === siteCode)) {
        this.add(gross, l);
        if (l.kind === 'transfer') this.add(transferredIn, l);
      }
      rows.push({
        siteCode,
        gross,
        transferredIn,
        net: {
          CO2: gross.CO2.sub(transferredIn.CO2),
          CH4: gross.CH4.sub(transferredIn.CH4),
          N2O: gross.N2O.sub(transferredIn.N2O),
          CO2E: gross.CO2E.sub(transferredIn.CO2E)
        }
      });
    }

    const gross = zeroTotals();
    const internalElimination = zeroTotals();
    for (const l of leaves) {
      this.add(gross, l);
      if (l.kind === 'transfer') this.add(internalElimination, l);
    }
    return {
      gross,
      internalElimination,
      net: {
        CO2: gross.CO2.sub(internalElimination.CO2),
        CH4: gross.CH4.sub(internalElimination.CH4),
        N2O: gross.N2O.sub(internalElimination.N2O),
        CO2E: gross.CO2E.sub(internalElimination.CO2E)
      },
      sites: rows
    };
  }

  private add(t: GasTotals, leaf: AccountingLeaf): void {
    if (leaf.kind === 'transfer') {
      t[leaf.gas] = t[leaf.gas].add(leaf.gasTonnes);
      t.CO2E = t.CO2E.add(leaf.co2eTonnes);
      return;
    }
    for (const gas of GASES) {
      t[gas] = t[gas].add(leaf.byGas[gas].gasTonnes);
      t.CO2E = t.CO2E.add(leaf.byGas[gas].co2eTonnes);
    }
  }
}

@Module({
  imports: [AccountingModule],
  providers: [CompanyService],
  exports: [CompanyService]
})
export class CompanyModule {}
