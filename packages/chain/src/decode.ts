import type { Address, ChainListing, ChainNode, ChainPlan, ChainRental } from '@archcore/shared';
import type { StatusMapper } from './status';

/**
 * Field decode helpers.
 *
 * Stylus contract getters return flat, unnamed tuples, so the column order
 * comes from the actual source-generated ABI and is asserted in conformance tests.
 * Named objects are supported for typed test/read adapters. Optional legacy field
 * order parameters can only restate the frozen order; they cannot redefine it.
 */
export type RawGetterResult = unknown;

const RENTAL_ALIASES: Record<string, string[]> = {
  rentalId: ['rentalId', 'rental_id', 'id', 'rental'],
  nodeId: ['nodeId', 'node_id', 'node', 'assetId'],
  planId: ['planId', 'plan_id', 'plan'],
  renter: ['renter', 'renterAddress', 'renter_address', 'tenant', 'lessee'],
  provider: ['provider', 'providerAddress', 'provider_address', 'owner', 'host'],
  priceAtomic: ['priceAtomic', 'price_atomic', 'price', 'priceWei', 'amount', 'escrow'],
  durationSeconds: ['durationSeconds', 'duration_seconds', 'duration'],
  status: ['status', 'state', 'rentalStatus', 'rental_status'],
  startDeadline: ['startDeadline', 'start_deadline', 'deadline', 'startBy', 'graceDeadline'],
  startsAt: ['startsAt', 'starts_at', 'startAt', 'start_at', 'startedAt', 'startTime'],
  expiresAt: ['expiresAt', 'expires_at', 'expiry', 'expiryAt', 'endAt', 'endsAt', 'endTime'],
  createdAt: ['createdAt', 'created_at', 'createdTime', 'created'],
};

const NODE_ALIASES: Record<string, string[]> = {
  nodeId: ['nodeId', 'node_id', 'id', 'assetId', 'tokenId'],
  provider: ['provider', 'owner', 'providerAddress', 'provider_address'],
  name: ['name', 'deviceName', 'device_name', 'label'],
  active: ['active', 'isActive', 'is_active', 'listed', 'enabled'],
};

const LISTING_ALIASES: Record<string, string[]> = {
  nodeId: ['nodeId', 'node_id', 'id', 'assetId'],
  paymentToken: ['paymentToken', 'payment_token', 'token', 'paymentAddress'],
  active: ['active', 'isActive', 'is_active', 'listed', 'enabled'],
};

const PLAN_ALIASES: Record<string, string[]> = {
  planId: ['planId', 'plan_id', 'id'],
  durationSeconds: ['durationSeconds', 'duration_seconds', 'duration'],
  priceAtomic: ['priceAtomic', 'price_atomic', 'price', 'amount'],
  active: ['active', 'isActive', 'is_active'],
  demoOnly: ['demoOnly', 'demo_only', 'isDemo'],
};

export function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Field "${field}" is not a safe integer: ${String(value)}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(`Field "${field}" is not an integer value: ${String(value)}`);
}

export function asNumber(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Field "${field}" is not an integer: ${String(value)}`);
    }
    return value;
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
      throw new Error(`Field "${field}" exceeds safe JavaScript integer range: ${value}`);
    }
    return Number(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const num = Number(value.trim());
    if (Number.isSafeInteger(num)) return num;
  }
  throw new Error(`Field "${field}" is not a valid number: ${String(value)}`);
}

export function asAddress(value: unknown, field: string): Address {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return value.toLowerCase() as Address;
  }
  throw new Error(`Field "${field}" is not a valid 20-byte address: ${String(value)}`);
}

export function asString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'toString' in value) {
    // alloy/viem Bytes32 might be represented as hex or buffer
    const s = String(value);
    if (/^0x[0-9a-fA-F]+$/.test(s)) {
      return s;
    }
  }
  throw new Error(`Field "${field}" is not a string: ${String(value)}`);
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  throw new Error(`Field "${field}" is not a boolean: ${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickByAlias(
  source: Record<string, unknown>,
  aliases: string[],
  field: string,
): unknown {
  const lowerToKey = new Map<string, string>(
    Object.keys(source).map((key) => [key.toLowerCase(), key] as const),
  );
  for (const alias of aliases) {
    const key = lowerToKey.get(alias.toLowerCase());
    if (key !== undefined) return source[key];
  }
  throw new Error(
    `Missing field "${field}" in getter result. Received keys: [${Object.keys(source).join(', ')}].`,
  );
}

/**
 * Read all values either by alias-name (named outputs) or by an explicit
 * positional order, then hand back the raw record for diagnostics.
 */
function collect(
  result: RawGetterResult,
  aliases: Record<string, string[]>,
  positionalOrder: readonly string[] | undefined,
  decode: (field: string, value: unknown) => unknown,
  label: string,
): Record<string, unknown> {
  let byField: Record<string, unknown>;

  if (isRecord(result)) {
    byField = {};
    for (const field of Object.keys(aliases)) {
      byField[field] = decode(field, pickByAlias(result, aliases[field], field));
    }
    return byField;
  }

  if (Array.isArray(result)) {
    const flat = result.length === 1 && Array.isArray(result[0]) ? (result[0] as unknown[]) : result;
    if (positionalOrder && positionalOrder.length > 0) {
      if (positionalOrder.length !== flat.length) {
        throw new Error(
          `${label} positional order has ${positionalOrder.length} fields but the getter returned ${flat.length}. ` +
            `Expected ${label} tuple width ${positionalOrder.length}.`,
        );
      }
      byField = {};
      for (const [index, field] of positionalOrder.entries()) {
        const aliasGroup = aliases[field];
        if (!aliasGroup) {
          throw new Error(`${label} positional order contains unknown field "${field}".`);
        }
        byField[field] = decode(field, flat[index]);
      }
      return byField;
    }

    throw new Error(
      `${label} getter returned ${flat.length} positional values and no field order is configured.`,
    );
  }

  throw new Error(`${label} getter returned an unsupported shape: ${typeof result}`);
}

export interface DecodeOptions {
  status: StatusMapper;
  rentalFieldsOrder?: string;
  nodeFieldsOrder?: string;
  listingFieldsOrder?: string;
  planFieldsOrder?: string;
}

/**
 * Positional order of the `getRental` tuple as the contract exports it.
 *
 * `get_rental` returns one flat 12-tuple in this exact order:
 * rentalId, nodeId, planId, renter, provider, priceAtomic,
 * durationSeconds, status, startDeadline, startsAt, expiresAt, createdAt
 */
export const REAL_RENTAL_FIELDS_ORDER = [
  'rentalId',
  'nodeId',
  'planId',
  'renter',
  'provider',
  'priceAtomic',
  'durationSeconds',
  'status',
  'startDeadline',
  'startsAt',
  'expiresAt',
  'createdAt',
] as const;

export const DEFAULT_RENTAL_FIELDS_ORDER = REAL_RENTAL_FIELDS_ORDER;

/**
 * Positional order of the `getNode` tuple:
 * nodeId, provider, name, active
 */
export const REAL_NODE_FIELDS_ORDER = [
  'nodeId',
  'provider',
  'name',
  'active',
] as const;

export const DEFAULT_NODE_FIELDS_ORDER = REAL_NODE_FIELDS_ORDER;

/**
 * Positional order of the `getListing` tuple:
 * nodeId, paymentToken, active
 */
export const REAL_LISTING_FIELDS_ORDER = [
  'nodeId',
  'paymentToken',
  'active',
] as const;

export const DEFAULT_LISTING_FIELDS_ORDER = REAL_LISTING_FIELDS_ORDER;

/**
 * Positional order of the `getPlan` tuple:
 * planId, durationSeconds, priceAtomic, active, demoOnly
 */
export const REAL_PLAN_FIELDS_ORDER = [
  'planId',
  'durationSeconds',
  'priceAtomic',
  'active',
  'demoOnly',
] as const;

export const DEFAULT_PLAN_FIELDS_ORDER = REAL_PLAN_FIELDS_ORDER;

export const EMPTY_ADDRESS = '0x0000000000000000000000000000000000000000';

export function parseFieldOrder(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = value
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function frozenFieldOrder(value: string | undefined, expected: readonly string[]): readonly string[] {
  const explicit = parseFieldOrder(value);
  if (explicit && (explicit.length !== expected.length || explicit.some((name, index) => name !== expected[index]))) {
    throw new Error('Tuple field order must match the current source-generated v0.5 ABI.');
  }
  return expected;
}

export function decodeRental(
  result: RawGetterResult,
  raw: Record<string, unknown>,
  options: DecodeOptions,
): ChainRental {
  const decoded = collect(
    result,
    RENTAL_ALIASES,
    frozenFieldOrder(options.rentalFieldsOrder, REAL_RENTAL_FIELDS_ORDER),
    (field, value) => value,
    'Rental',
  );

  const priceAtomic = asBigInt(decoded.priceAtomic, 'priceAtomic');
  const rental: ChainRental = {
    rentalId: asBigInt(decoded.rentalId, 'rentalId'),
    nodeId: asBigInt(decoded.nodeId, 'nodeId'),
    planId: asNumber(decoded.planId, 'planId'),
    renter: asAddress(decoded.renter, 'renter'),
    provider: asAddress(decoded.provider, 'provider'),
    priceAtomic,
    durationSeconds: asBigInt(decoded.durationSeconds, 'durationSeconds'),
    status: options.status.fromChain(decoded.status),
    startDeadline: asBigInt(decoded.startDeadline, 'startDeadline'),
    startsAt: asBigInt(decoded.startsAt, 'startsAt'),
    expiresAt: asBigInt(decoded.expiresAt, 'expiresAt'),
    createdAt: asBigInt(decoded.createdAt, 'createdAt'),
    price: priceAtomic,
    raw: Object.keys(raw).length > 0 ? raw : decoded,
  };
  return rental;
}

export function decodeNode(
  result: RawGetterResult,
  options?: Partial<DecodeOptions>,
): ChainNode {
  const decoded = collect(
    result,
    NODE_ALIASES,
    frozenFieldOrder(options?.nodeFieldsOrder, REAL_NODE_FIELDS_ORDER),
    (field, value) => value,
    'Node',
  );
  return {
    nodeId: asBigInt(decoded.nodeId, 'nodeId'),
    provider: asAddress(decoded.provider, 'provider'),
    name: asString(decoded.name, 'name'),
    active: asBoolean(decoded.active, 'active'),
    raw: decoded,
  };
}

export function decodeListing(
  result: RawGetterResult,
  options?: Partial<DecodeOptions>,
): ChainListing {
  const decoded = collect(
    result,
    LISTING_ALIASES,
    frozenFieldOrder(options?.listingFieldsOrder, REAL_LISTING_FIELDS_ORDER),
    (field, value) => value,
    'Listing',
  );
  return {
    nodeId: asBigInt(decoded.nodeId, 'nodeId'),
    paymentToken: asAddress(decoded.paymentToken, 'paymentToken'),
    active: asBoolean(decoded.active, 'active'),
    raw: decoded,
  };
}

export function decodePlan(
  result: RawGetterResult,
  options?: Partial<DecodeOptions>,
): ChainPlan {
  const decoded = collect(
    result,
    PLAN_ALIASES,
    frozenFieldOrder(options?.planFieldsOrder, REAL_PLAN_FIELDS_ORDER),
    (field, value) => value,
    'Plan',
  );
  return {
    planId: asNumber(decoded.planId, 'planId'),
    durationSeconds: asBigInt(decoded.durationSeconds, 'durationSeconds'),
    priceAtomic: asBigInt(decoded.priceAtomic, 'priceAtomic'),
    active: asBoolean(decoded.active, 'active'),
    demoOnly: asBoolean(decoded.demoOnly, 'demoOnly'),
  };
}

/**
 * Decodes the raw return data of `activeRentalForNode(uint256)`:
 * returns `(hasRental: bool, rentalId: uint256)` tuple.
 * Fails closed on any unexpected or malformed shape.
 */
export function decodeActiveRentalForNode(result: unknown): [boolean, bigint] {
  if (Array.isArray(result) && result.length === 2) {
    return [asBoolean(result[0], 'hasRental'), asBigInt(result[1], 'rentalId')];
  }
  if (isRecord(result)) {
    const hasRental = result.hasRental ?? result[0];
    const rentalId = result.rentalId ?? result[1];
    if (hasRental !== undefined && rentalId !== undefined) {
      return [asBoolean(hasRental, 'hasRental'), asBigInt(rentalId, 'rentalId')];
    }
  }
  throw new Error(`activeRentalForNode returned an unsupported shape: ${typeof result}`);
}
