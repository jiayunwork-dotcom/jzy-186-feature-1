import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService, type Queryer } from '../database/database.module';
import { MasterDataModule } from '../master-data/master-data.service';
import {
  EnergyRecordsModule,
  EnergyRecordsService,
  type EnergyOutputInput,
  type EnergyTransferInput,
  type EnergyRecordResultItem
} from './energy-records.service';

/**
 * HTTP-facing entry point for internal energy production/transfer data.
 * Imports run in one transaction with the same per-record accept/duplicate/
 * reject semantics as activity bulk import.
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly db: DbService,
    private readonly energy: EnergyRecordsService
  ) {}

  importOutputs(records: EnergyOutputInput[]): Promise<EnergyRecordResultItem[]> {
    return this.db.withTransaction((client: Queryer) =>
      this.energy.importOutputs(client, records)
    );
  }

  importTransfers(records: EnergyTransferInput[]): Promise<EnergyRecordResultItem[]> {
    return this.db.withTransaction((client: Queryer) =>
      this.energy.importTransfers(client, records)
    );
  }
}

@Module({
  imports: [DbModule, MasterDataModule, EnergyRecordsModule],
  providers: [TransferService],
  exports: [TransferService, EnergyRecordsModule]
})
export class TransferModule {}
