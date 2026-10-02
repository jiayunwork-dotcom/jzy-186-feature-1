/** Field-level validation error: every rejection names the offending field. */
export interface FieldError {
  /** JSON path / field name, e.g. "records[3].quantity" or "factors[2].validTo". */
  field: string;
  code:
    | 'NEGATIVE_OR_NON_FINITE'
    | 'UNKNOWN_UNIT'
    | 'UNIT_NOT_CONVERTIBLE'
    | 'MONTH_OUTSIDE_FACTOR_PERIOD'
    | 'BAD_MONTH'
    | 'CORRECTION_TARGET_MISSING'
    | 'CORRECTION_TARGET_ALREADY_CORRECTED'
    | 'CORRECTION_CONFLICT'
    | 'FACTOR_PERIOD_OVERLAP'
    | 'NOT_FOUND'
    | 'MISSING_FIELD'
    | 'DUPLICATE_KEY'
    | 'SCOPE_MISMATCH'
    | 'FACTOR_NOT_APPLICABLE'
    | 'ALREADY_CLOSED'
    | 'TRANSFER_EXCEEDS_OUTPUT'
    | 'TRANSFER_TO_SELF'
    | 'TRANSFER_TARGET_NOT_FOUND'
    | 'TRANSFER_WITHOUT_OUTPUT'
    | 'CARRIER_MISMATCH'
    | 'ENERGY_UNIT_NOT_CONVERTIBLE'
    | 'ZERO_ENERGY_OUTPUT'
    | 'INVALID_VALUE';
  message: string;
  /** Present on per-record import results. */
  recordId?: string;
}

/**
 * Structural error of the internal energy-transfer network for a caliber.
 * `code` names the failure class; `facilities` names the involved facilities
 * as `${siteCode}/${facilityCode}` so the caller never has to guess which
 * part of the network is invalid (e.g. a fully closed loop with no final
 * energy use). The network solver always terminates: it never blocks and
 * never divides by zero — a singular system is reported through this error.
 */
export class NetworkStructureError extends Error {
  constructor(
    readonly code: 'CLOSED_LOOP_NO_FINAL_USE' | 'ZERO_ENERGY_OUTPUT',
    message: string,
    readonly facilities: string[],
    readonly month?: string
  ) {
    super(message);
    this.name = 'NetworkStructureError';
  }
}

export class ValidationException extends Error {
  constructor(
    readonly errors: FieldError[]
  ) {
    super(errors.map((e) => `${e.field}: ${e.message}`).join('; '));
    this.name = 'ValidationException';
  }
}

export class ConflictError extends Error {
  constructor(
    readonly field: string,
    message: string,
    readonly recordId?: string
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
