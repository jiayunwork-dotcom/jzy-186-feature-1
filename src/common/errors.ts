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
    | 'TRANSFER_WITHOUT_OUTPUT'
    | 'TRANSFER_TO_SELF'
    | 'CARRIER_EFFICIENCY_MISSING'
    | 'TRANSFER_NETWORK_NO_FINAL_USE'
    | 'INVALID_VALUE';
  message: string;
  /** Present on per-record import results. */
  recordId?: string;
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

/**
 * Accounting-time error in the monthly transfer network. Carries the exact
 * record field / month it applies to and — for the unreachable-loop case —
 * the list of facilities whose production never reaches a final use, so the
 * message names them instead of hanging or dividing by zero.
 */
export class TransferNetworkError extends Error {
  constructor(
    readonly code: FieldError['code'],
    message: string,
    readonly fields: FieldError[],
    readonly facilities?: string[]
  ) {
    super(message);
    this.name = 'TransferNetworkError';
  }
}
