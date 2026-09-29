/**
 * Rental operations: Web chain boundary routing exclusively through @archcore/chain.
 *
 * All ABI-backed calls, selector and calldata encoding, positional tuple decoding,
 * normalized objects, USDG metadata/balance/allowance/approval helpers, and receipt
 * verification are owned by @archcore/chain.
 *
 * Web never independently decodes tuple positions or maintains duplicate ERC-20/manager ABIs.
 */

import {
  areAddressesEqual,
  asAddress,
  ERC20_ABI,
  RentalManagerClient,
  StatusMapper,
  type ChainConfig,
  type EncodedTransactionRequest,
} from '@archcore/chain';
import {
  createPublicClient,
  custom,
  defineChain,
  type Hex,
} from 'viem';

import type { AgentConfig } from './config';
import {
  CHAIN_ID,
  DEFAULT_RPC_URL,
  DEMO_NODE_ID,
  formatAtomic,
  USDG_ADDRESS,
  USDG_DECIMALS_EXPECTED,
  type Address,
  type ChainListing,
  type ChainNode,
  type ChainPlan,
  type ChainRental,
  type PaymentTokenMetadata,
  type RentalStatus,
} from './chainPure';
import { emptyRental } from './rentalState';
import { ensureChain, sendTransaction, type Eip1193Provider } from './wallet';

export class RentalOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RentalOpsError';
  }
}

/**
 * Safely converts an encoded request's zero native value to the hex quantity required by EIP-1193.
 * Fails closed if value is nonzero. Cannot produce a nonzero hex value.
 */
export function toZeroHexValue(value: 0n | bigint): '0x0' {
  if (value !== 0n) {
    throw new RentalOpsError(`Nonpayable transaction requires zero native value, received ${value}.`);
  }
  return '0x0';
}

/** The JSON-RPC transport interface for custom injection. */
export interface RpcTransport {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export const statusMapper = new StatusMapper();

export type AbiLike = readonly unknown[];

/**
 * Creates a normalized RentalManagerClient wrapping an RpcTransport via viem's custom transport.
 */
export function createClientFromRpc(
  rpc: RpcTransport,
  options: {
    chainId?: number;
    rentalManagerAddress: string;
    paymentTokenAddress?: string;
    nodeId?: bigint;
    rpcUrl?: string;
  },
): RentalManagerClient {
  const chainId = options.chainId ?? CHAIN_ID;
  const transport = custom({
    request: ({ method, params }) => rpc.request({ method, params: params as unknown[] }),
  });
  const publicClientOverride = createPublicClient({
    chain: defineChain({
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl ?? DEFAULT_RPC_URL] } },
    }),
    transport,
  });
  return RentalManagerClient.create({
    chainId,
    rpcUrl: options.rpcUrl ?? DEFAULT_RPC_URL,
    rentalManagerAddress: options.rentalManagerAddress,
    paymentTokenAddress: options.paymentTokenAddress ?? USDG_ADDRESS,
    nodeId: options.nodeId ?? DEMO_NODE_ID,
    publicClientOverride,
  });
}

/**
 * Renter-facing chain reader wrapping the normalized @archcore/chain client.
 */
export class RentalReader {
  readonly client: RentalManagerClient;

  constructor(client: RentalManagerClient);
  constructor(clientOrConfig: RentalManagerClient | ChainConfig);
  constructor(
    clientOrConfigOrRpc: RentalManagerClient | ChainConfig | RpcTransport,
    address?: string,
    abi?: AbiLike,
  );
  constructor(
    first: RentalManagerClient | ChainConfig | RpcTransport,
    address?: string,
    _abi?: AbiLike,
  ) {
    if (first instanceof RentalManagerClient) {
      this.client = first;
    } else if (typeof first === 'object' && first !== null && 'chainId' in first && 'rentalManagerAddress' in first) {
      this.client = RentalManagerClient.create(first as ChainConfig);
    } else {
      this.client = createClientFromRpc(first as RpcTransport, {
        rentalManagerAddress: address ?? '',
      });
    }
  }

  async getNode(nodeId: bigint): Promise<ChainNode> {
    try {
      return await this.client.getNode(nodeId);
    } catch (error) {
      if (error instanceof RentalOpsError) throw error;
      throw new RentalOpsError(`getNode failed for node ${nodeId}: ${String(error)}`);
    }
  }

  async getListing(nodeId: bigint): Promise<ChainListing> {
    try {
      return await this.client.getListing(nodeId);
    } catch (error) {
      if (error instanceof RentalOpsError) throw error;
      throw new RentalOpsError(`getListing failed for node ${nodeId}: ${String(error)}`);
    }
  }

  async planCount(): Promise<number> {
    try {
      return await this.client.planCount();
    } catch (error) {
      if (error instanceof RentalOpsError) throw error;
      throw new RentalOpsError(`planCount failed: ${String(error)}`);
    }
  }

  async getPlan(planId: number): Promise<ChainPlan> {
    try {
      return await this.client.getPlan(planId);
    } catch (error) {
      if (error instanceof RentalOpsError) throw error;
      throw new RentalOpsError(`getPlan failed for plan ${planId}: ${String(error)}`);
    }
  }

  async listPlans(): Promise<readonly ChainPlan[]> {
    const count = await this.planCount();
    if (count <= 0) return [];
    return Promise.all(
      Array.from({ length: count }, (_, index) => this.getPlan(index)),
    );
  }

  async getRental(rentalId: bigint): Promise<ChainRental> {
    try {
      const rental = await this.client.getRental(rentalId);
      return rental ?? emptyRental();
    } catch (error) {
      if (error instanceof RentalOpsError) throw error;
      throw new RentalOpsError(`getRental failed for rental ${rentalId}: ${String(error)}`);
    }
  }

  async getActiveRentalForNode(nodeId: bigint): Promise<ChainRental> {
    try {
      const rental = await this.client.getActiveRentalForNode(nodeId);
      return rental ?? emptyRental();
    } catch (error) {
      if (error instanceof RentalOpsError) throw error;
      throw new RentalOpsError(`getActiveRentalForNode failed for node ${nodeId}: ${String(error)}`);
    }
  }

  /**
   * Local ergonomic helper delegating strictly to normalized getActiveRentalForNode.
   */
  async nodeIsRented(nodeId: bigint): Promise<boolean> {
    try {
      const rental = await this.client.getActiveRentalForNode(nodeId);
      return rental !== null;
    } catch (error) {
      if (error instanceof RentalOpsError) throw error;
      throw new RentalOpsError(`nodeIsRented check failed for node ${nodeId}: ${String(error)}`);
    }
  }

  /**
   * Evaluates all four rent eligibility predicates per ledger §4.
   */
  async isNodeRentable(
    nodeId: bigint,
    planId: number,
  ): Promise<{ eligible: boolean; reason?: string }> {
    try {
      return await this.client.isNodeRentable(nodeId, planId);
    } catch (error) {
      if (error instanceof RentalOpsError) throw error;
      throw new RentalOpsError(`isNodeRentable failed for node ${nodeId}, plan ${planId}: ${String(error)}`);
    }
  }

  async quoteRent(nodeId: bigint, planId: number): Promise<RentQuote> {
    try {
      const [plan, rentable] = await Promise.all([
        this.getPlan(planId),
        this.isNodeRentable(nodeId, planId),
      ]);
      return {
        nodeId,
        planId: plan.planId,
        priceAtomic: plan.priceAtomic,
        durationSeconds: plan.durationSeconds,
        available: rentable.eligible,
      };
    } catch (error) {
      if (error instanceof RentalOpsError) throw error;
      throw new RentalOpsError(`quoteRent failed for node ${nodeId}, plan ${planId}: ${String(error)}`);
    }
  }
}

export type NodeView = ChainNode;
export type ListingView = ChainListing;
export type PlanView = ChainPlan;

export interface RentQuote {
  nodeId: bigint;
  planId: number;
  priceAtomic: bigint;
  durationSeconds: bigint;
  available: boolean;
}

export interface RentOutcome {
  hash: string;
  quote: RentQuote;
}

export interface PaymentTokenView {
  address: string;
  decimals: number;
  symbol: string;
  balance: bigint;
  allowance: bigint;
}

export interface CheckoutProgress {
  onProgress?: (message: string) => void;
  /** The finished renter UI has separate Approve and Rent actions. */
  allowApproval?: boolean;
}

/** Explicit approval step. Never sends rent or an unlimited approval. */
export async function approveRental(
  wallet: Eip1193Provider, client: RentalManagerClient, quote: RentQuote,
  account: string, onProgress: (message: string) => void = () => {},
): Promise<string | null> {
  await ensureChain(wallet);
  const eligible = await client.isNodeRentable(quote.nodeId, quote.planId);
  if (!eligible.eligible) throw new RentalOpsError(eligible.reason ?? 'Node is unavailable.');
  const token = await client.paymentToken();
  if (!areAddressesEqual(token, USDG_ADDRESS)) throw new RentalOpsError('Payment token does not match frozen USDG.');
  const [plan, payment] = await Promise.all([
    client.getPlan(quote.planId), readPaymentToken(client, account, token),
  ]);
  if (payment.decimals !== USDG_DECIMALS_EXPECTED) throw new RentalOpsError('USDG decimals verification failed.');
  if (payment.balance < plan.priceAtomic) throw new RentalOpsError('Insufficient USDG balance for this plan.');
  if (payment.allowance >= plan.priceAtomic) return null;
  onProgress('Confirm the exact USDG approval in your wallet…');
  const tx = client.encodeApproveCalldata(client.config.rentalManagerAddress, plan.priceAtomic, token);
  const hash = await sendTransaction(wallet, { from: account, to: tx.to, data: tx.data, value: toZeroHexValue(tx.value) });
  onProgress(`Approval pending · ${hash.slice(0, 10)}…`);
  await client.waitForTransactionSuccess(hash as Hex);
  const allowance = await client.getTokenAllowance(asAddress(account, 'account'), undefined, token);
  if (allowance < plan.priceAtomic) throw new RentalOpsError('Approval mined, but allowance is still insufficient.');
  onProgress('USDG approval confirmed. You can now reserve the node.');
  return hash;
}

/**
 * Reads token metadata, balance, and allowance via the chain package.
 */
export async function readPaymentToken(
  clientOrRpc: RentalManagerClient | RpcTransport,
  accountOrToken: string,
  tokenOrAccount?: string,
  spender?: string,
): Promise<PaymentTokenView> {
  let client: RentalManagerClient;
  let account: string;
  let token: string | undefined;
  let actualSpender: string | undefined;

  if (clientOrRpc instanceof RentalManagerClient) {
    client = clientOrRpc;
    account = accountOrToken;
    token = tokenOrAccount;
    actualSpender = spender;
  } else {
    const rpc = clientOrRpc as RpcTransport;
    token = accountOrToken;
    account = tokenOrAccount ?? '';
    actualSpender = spender;
    client = createClientFromRpc(rpc, {
      rentalManagerAddress: actualSpender ?? '',
      paymentTokenAddress: token,
    });
  }

  try {
    const tokenAddress = (token
      ? asAddress(token, 'tokenAddress')
      : await client.paymentToken()) as Address;
    const spenderAddress = asAddress(
      actualSpender ?? client.config.rentalManagerAddress,
      'spenderAddress',
    );

    const [metadata, balance, allowance] = await Promise.all([
      client.getPaymentTokenMetadata(tokenAddress),
      client.getTokenBalance(account as Address, tokenAddress),
      client.getTokenAllowance(account as Address, spenderAddress, tokenAddress),
    ]);

    return {
      address: metadata.address,
      decimals: metadata.decimals,
      symbol: metadata.symbol,
      balance,
      allowance,
    };
  } catch (error) {
    if (error instanceof RentalOpsError) throw error;
    throw new RentalOpsError(`Failed to read payment token data: ${String(error)}`);
  }
}

/**
 * Executes rent checkout using @archcore/chain client and exact ledger rules.
 */
export async function rent(
  wallet: Eip1193Provider,
  clientOrRpc: RentalManagerClient | RpcTransport,
  arg3: AgentConfig | RentQuote | string,
  arg4?: unknown,
  arg5?: RentQuote,
  arg6?: string,
  progress: CheckoutProgress = {},
): Promise<RentOutcome> {
  let client: RentalManagerClient;
  let quote: RentQuote | undefined;
  let account: string;
  let planId: number;
  let nodeId: bigint = 1n;

  if (clientOrRpc instanceof RentalManagerClient) {
    client = clientOrRpc;
    if (typeof arg6 === 'string' && arg5) {
      quote = arg5;
      account = arg6;
      planId = quote.planId;
      nodeId = quote.nodeId;
    } else if (typeof arg3 === 'object' && 'priceAtomic' in arg3 && typeof arg4 === 'string') {
      quote = arg3 as RentQuote;
      account = arg4;
      planId = quote.planId;
      nodeId = quote.nodeId;
    } else if (typeof arg3 === 'string' && typeof arg4 === 'number') {
      account = arg3;
      planId = arg4;
      if (typeof arg5 === 'bigint') nodeId = arg5;
    } else {
      throw new RentalOpsError('Invalid arguments to rent()');
    }
  } else {
    const rpc = clientOrRpc as RpcTransport;
    const config = arg3 as AgentConfig;
    quote = arg5;
    account = arg6 as string;
    if (!quote || !account) {
      throw new RentalOpsError('quote and account are required for rent()');
    }
    planId = quote.planId;
    nodeId = quote.nodeId;
    client = createClientFromRpc(rpc, {
      chainId: config.chainId,
      rentalManagerAddress: config.rentalManagerAddress,
      paymentTokenAddress: config.paymentToken,
      nodeId: config.nodeId,
      rpcUrl: config.rpcUrl,
    });
  }

  // Refuse immediately if pre-read quote is unavailable
  if (quote && !quote.available) {
    throw new RentalOpsError('This node is not available for rent right now.');
  }

  // 1. Guard network
  await ensureChain(wallet);
  const eligibility = await client.isNodeRentable(nodeId, planId);
  if (!eligibility.eligible) throw new RentalOpsError(eligibility.reason ?? 'Node unavailable.');

  const managerAddress = asAddress(client.config.rentalManagerAddress, 'rentalManagerAddress');

  // 2. Verify token address equals the frozen USDG address
  let tokenAddress: Address;
  try {
    tokenAddress = (await client.paymentToken()) as Address;
  } catch (error) {
    throw new RentalOpsError(`Failed to resolve payment token address: ${String(error)}`);
  }

  if (!areAddressesEqual(tokenAddress, USDG_ADDRESS)) {
    throw new RentalOpsError(
      `Payment token address ${tokenAddress} does not match expected frozen USDG address ${USDG_ADDRESS}.`,
    );
  }
  if (
    client.config.paymentTokenAddress &&
    !areAddressesEqual(client.config.paymentTokenAddress, USDG_ADDRESS)
  ) {
    throw new RentalOpsError(
      `Payment token address ${client.config.paymentTokenAddress} does not match expected frozen USDG address ${USDG_ADDRESS}.`,
    );
  }

  // 3. Require verified decimals == 6
  let metadata: PaymentTokenMetadata;
  try {
    metadata = await client.getPaymentTokenMetadata(tokenAddress);
  } catch (error) {
    throw new RentalOpsError(`Failed to read payment token metadata: ${String(error)}`);
  }

  if (metadata.decimals !== USDG_DECIMALS_EXPECTED) {
    throw new RentalOpsError(
      `Payment token decimals mismatch: expected ${USDG_DECIMALS_EXPECTED}, observed ${metadata.decimals}.`,
    );
  }

  // 4. Initial plan read
  let selectedPlan: ChainPlan;
  try {
    selectedPlan = await client.getPlan(planId);
  } catch (error) {
    throw new RentalOpsError(`Failed to read plan ${planId}: ${String(error)}`);
  }

  const required = selectedPlan.priceAtomic;

  // 5. Check renter balance and manager allowance
  let balance: bigint;
  let allowance: bigint;
  try {
    [balance, allowance] = await Promise.all([
      client.getTokenBalance(account as Address, tokenAddress),
      client.getTokenAllowance(account as Address, managerAddress, tokenAddress),
    ]);
  } catch (error) {
    throw new RentalOpsError(`Failed to read token balance or allowance: ${String(error)}`);
  }

  if (balance < required) {
    throw new RentalOpsError(
      `This rental needs ${formatAtomic(required, metadata.decimals, metadata.symbol)} but the wallet holds ${formatAtomic(balance, metadata.decimals, metadata.symbol)}.`,
    );
  }

  // 6. If allowance is insufficient, approve exactly selectedPlan.priceAtomic
  if (allowance < required) {
    if (progress.allowApproval === false) throw new RentalOpsError('Approve the selected USDG amount before renting.');
    progress.onProgress?.('Confirm the exact USDG approval in your wallet…');
    const approveTx = client.encodeApproveCalldata(managerAddress, required, tokenAddress);
    const approvalHash = await sendTransaction(wallet, {
      from: account,
      to: approveTx.to,
      data: approveTx.data,
      value: toZeroHexValue(approveTx.value),
    });
    progress.onProgress?.(`Approval pending · ${approvalHash.slice(0, 10)}…`);
    try {
      await client.waitForTransactionSuccess(approvalHash as Hex);
    } catch (error) {
      throw new RentalOpsError(`The USDG approval reverted or failed: ${String(error)}`);
    }

    // Reread allowance before rent
    try {
      allowance = await client.getTokenAllowance(account as Address, managerAddress, tokenAddress);
    } catch (error) {
      throw new RentalOpsError(`Failed to reread allowance after approval: ${String(error)}`);
    }
    if (allowance < required) {
      throw new RentalOpsError(
        `Allowance insufficient after approval (expected at least ${required}, got ${allowance}).`,
      );
    }
  }

  // 7. Reread active node, active listing, selected active plan, occupancy, balance, and allowance before send
  let freshNode: ChainNode;
  let freshListing: ChainListing;
  let freshPlan: ChainPlan;
  let freshOccupancy: ChainRental | null;
  let freshBalance: bigint;
  let freshAllowance: bigint;
  try {
    [freshNode, freshListing, freshPlan, freshOccupancy, freshBalance, freshAllowance] =
      await Promise.all([
        client.getNode(nodeId),
        client.getListing(nodeId),
        client.getPlan(planId),
        client.getActiveRentalForNode(nodeId),
        client.getTokenBalance(account as Address, tokenAddress),
        client.getTokenAllowance(account as Address, managerAddress, tokenAddress),
      ]);
  } catch (error) {
    throw new RentalOpsError(`Pre-rent chain reread failed: ${String(error)}`);
  }

  if (!freshNode.active) {
    throw new RentalOpsError(`Node ${nodeId} is inactive.`);
  }
  if (!freshListing.active) {
    throw new RentalOpsError(`Listing for node ${nodeId} is inactive.`);
  }
  if (!freshPlan.active) {
    throw new RentalOpsError(`Plan ${planId} is inactive.`);
  }
  if (freshOccupancy !== null) {
    throw new RentalOpsError(
      `Node ${nodeId} is already rented (active rental ${freshOccupancy.rentalId}).`,
    );
  }
  if (freshBalance < freshPlan.priceAtomic) {
    throw new RentalOpsError(`Insufficient USDG balance on pre-rent check.`);
  }
  if (freshAllowance < freshPlan.priceAtomic) {
    throw new RentalOpsError(`Insufficient USDG allowance on pre-rent check.`);
  }

  // 8. Build/send only nonpayable rent(1, planId), with zero ETH value
  const rentTx = client.encodeRentCalldata(nodeId, planId);
  await ensureChain(wallet);
  progress.onProgress?.('Confirm the rental transaction in your wallet…');

  const hash = await sendTransaction(wallet, {
    to: rentTx.to,
    data: rentTx.data,
    value: toZeroHexValue(rentTx.value),
    from: account,
  });
  progress.onProgress?.(`Rent pending · ${hash.slice(0, 10)}…`);

  // 9. Wait for mined successful receipt
  try {
    await client.waitForTransactionSuccess(hash as Hex);
  } catch (error) {
    throw new RentalOpsError(`rent() reverted or failed onchain: ${String(error)}`);
  }

  // 10. Fresh normalized chain reads confirm RESERVED
  let confirmedRental: ChainRental | null;
  try {
    confirmedRental = await client.getActiveRentalForNode(nodeId);
  } catch (error) {
    throw new RentalOpsError(`Post-rent chain verification failed: ${String(error)}`);
  }

  if (!confirmedRental || !['RESERVED', 'ACTIVE'].includes(confirmedRental.status)
    || !areAddressesEqual(confirmedRental.renter, account) || confirmedRental.planId !== planId) {
    throw new RentalOpsError(
      `Rent mined but its fresh reservation could not be verified (observed: ${confirmedRental?.status ?? 'NONE'}).`,
    );
  }

  return {
    hash,
    quote: quote ?? {
      nodeId,
      planId: freshPlan.planId,
      priceAtomic: freshPlan.priceAtomic,
      durationSeconds: freshPlan.durationSeconds,
      available: true,
    },
  };
}

/**
 * Sends cancelExpiredReservation using @archcore/chain calldata encoder.
 */
export async function cancelExpiredReservation(
  wallet: Eip1193Provider,
  clientOrRpc: RentalManagerClient | RpcTransport,
  ...rest: unknown[]
): Promise<string> {
  let client: RentalManagerClient;
  let rentalId: bigint;

  if (clientOrRpc instanceof RentalManagerClient) {
    client = clientOrRpc;
    rentalId = (typeof rest[rest.length - 1] === 'bigint'
      ? rest[rest.length - 1]
      : typeof rest[0] === 'bigint'
        ? rest[0]
        : 0n) as bigint;
  } else {
    const rpc = clientOrRpc as RpcTransport;
    const config = rest[0] as AgentConfig;
    rentalId = (typeof rest[rest.length - 1] === 'bigint'
      ? rest[rest.length - 1]
      : 0n) as bigint;
    client = createClientFromRpc(rpc, {
      chainId: config.chainId,
      rentalManagerAddress: config.rentalManagerAddress,
      rpcUrl: config.rpcUrl,
    });
  }

  await ensureChain(wallet);
  const cancelTx = client.encodeCancelExpiredReservationCalldata(rentalId);

  const hash = await sendTransaction(wallet, {
    to: cancelTx.to,
    data: cancelTx.data,
    value: toZeroHexValue(cancelTx.value),
  });

  try {
    await client.waitForTransactionSuccess(hash as Hex);
  } catch (error) {
    throw new RentalOpsError(`cancelExpiredReservation() reverted or failed: ${String(error)}`);
  }

  return hash;
}

/**
 * Sends settleAfterExpiry using @archcore/chain calldata encoder.
 */
export async function settleAfterExpiry(
  wallet: Eip1193Provider,
  clientOrRpc: RentalManagerClient | RpcTransport,
  ...rest: unknown[]
): Promise<string> {
  let client: RentalManagerClient;
  let rentalId: bigint;

  if (clientOrRpc instanceof RentalManagerClient) {
    client = clientOrRpc;
    rentalId = (typeof rest[rest.length - 1] === 'bigint'
      ? rest[rest.length - 1]
      : typeof rest[0] === 'bigint'
        ? rest[0]
        : 0n) as bigint;
  } else {
    const rpc = clientOrRpc as RpcTransport;
    const config = rest[0] as AgentConfig;
    rentalId = (typeof rest[rest.length - 1] === 'bigint'
      ? rest[rest.length - 1]
      : 0n) as bigint;
    client = createClientFromRpc(rpc, {
      chainId: config.chainId,
      rentalManagerAddress: config.rentalManagerAddress,
      rpcUrl: config.rpcUrl,
    });
  }

  await ensureChain(wallet);
  const settleTx = client.encodeSettleAfterExpiryCalldata(rentalId);

  const hash = await sendTransaction(wallet, {
    to: settleTx.to,
    data: settleTx.data,
    value: toZeroHexValue(settleTx.value),
  });

  try {
    await client.waitForTransactionSuccess(hash as Hex);
  } catch (error) {
    throw new RentalOpsError(`settleAfterExpiry() reverted or failed: ${String(error)}`);
  }

  return hash;
}

/**
 * Waits for transaction receipt and checks status.
 */
export async function waitForReceipt(
  rpcOrClient: RpcTransport | RentalManagerClient,
  hash: string,
): Promise<'success' | 'reverted'> {
  if (rpcOrClient instanceof RentalManagerClient) {
    try {
      await rpcOrClient.waitForTransactionSuccess(hash as Hex);
      return 'success';
    } catch {
      return 'reverted';
    }
  }
  const client = createClientFromRpc(rpcOrClient, {
    rentalManagerAddress: USDG_ADDRESS,
  });
  try {
    await client.waitForTransactionSuccess(hash as Hex);
    return 'success';
  } catch {
    return 'reverted';
  }
}

export { ERC20_ABI, areAddressesEqual };
export type { ChainRental, RentalStatus, ChainNode, ChainListing, ChainPlan, EncodedTransactionRequest };
