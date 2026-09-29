import { DEFAULT_RENTAL_STATUS_ORDER, type RentalStatus } from '@archcore/shared';

/**
 * `RentalStatus` enum mapping.
 *
 * The numeric order is frozen by the v0.5 source/ABI/ledger conformance tests.
 * Unknown values and attempts to reorder the enum fail closed.
 */
export class StatusMapper {
  private readonly order: readonly string[];

  constructor(order?: readonly string[]) {
    const source = order && order.length > 0 ? order : DEFAULT_RENTAL_STATUS_ORDER;
    const normalized = source.map((name) => name.trim().toUpperCase()).filter(Boolean);
    if (normalized.length !== DEFAULT_RENTAL_STATUS_ORDER.length ||
        normalized.some((value, index) => value !== DEFAULT_RENTAL_STATUS_ORDER[index])) {
      throw new Error('Rental status order must exactly match the frozen v0.5 enum.');
    }
    this.order = normalized;
  }

  get orderList(): readonly string[] {
    return this.order;
  }

  fromChain(value: unknown): RentalStatus {
    if (typeof value === 'string') {
      const name = value.trim().toUpperCase();
      if (!this.order.includes(name)) {
        throw new Error(`Unknown rental status name from chain: ${value}`);
      }
      return name as RentalStatus;
    }
    let index: number;
    if (typeof value === 'bigint') index = Number(value);
    else if (typeof value === 'number') index = value;
    else throw new Error(`Unsupported rental status type from chain: ${typeof value}`);

    const name = this.order[index];
    if (!name) {
      throw new Error(
        `Rental status index ${index} is outside the configured order (${this.order.join(', ')}). ` +
          `Check the generated ABI and interface ledger.`,
      );
    }
    return name as RentalStatus;
  }
}
