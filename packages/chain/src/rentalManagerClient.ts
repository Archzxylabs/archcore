import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeFunctionData,
  http,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abiFunctionNames, loadAbi, resolveAbiPath, type Abi } from './abi';
import {
  asAddress,
  asBigInt,
  asNumber,
  asString,
  decodeActiveRentalForNode,
  decodeListing,
  decodeNode,
  decodePlan,
  decodeRental,
  EMPTY_ADDRESS,
  type DecodeOptions,
} from './decode';
import { StatusMapper } from './status';
import type {
  Address,
  ChainListing,
  ChainNode,
  ChainPlan,
  ChainRental,
  PaymentTokenMetadata,
} from '@archcore/shared';

/**
 * Standard ERC-20 ABI used for payment token reads and approvals.
 */
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'symbol',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

/**
 * Exact 11 production `RentalManager` methods required by ledger §2.
 */
export const DEFAULT_METHODS = {
  paymentToken: 'paymentToken',
  planCount: 'planCount',
  getPlan: 'getPlan',
  getNode: 'getNode',
  getListing: 'getListing',
  getRental: 'getRental',
  activeRentalForNode: 'activeRentalForNode',
  rent: 'rent',
  startRental: 'startRental',
  cancelExpiredReservation: 'cancelExpiredReservation',
  settleAfterExpiry: 'settleAfterExpiry',
} as const;

export type MethodName = keyof typeof DEFAULT_METHODS;

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  rentalManagerAddress: string;
  computeAssetAddress?: string;
  paymentTokenAddress?: string;
  nodeId: bigint;
  /** Provider wallet key. Only ever used by the Agent, never by the frontend. */
  providerPrivateKey?: Hex;
  statusOrder?: string;
  rentalFieldsOrder?: string;
  nodeFieldsOrder?: string;
  listingFieldsOrder?: string;
  planFieldsOrder?: string;
  abiDir?: string;
  rentalManagerAbiPath?: string;
  computeAssetAbiPath?: string;
  explorerUrl?: string;
  /** Method-name overrides, if needed for testing. */
  methodOverrides?: Partial<Record<MethodName, string>>;
  /** Injected for tests. */
  publicClientOverride?: PublicClient;
  walletClientOverride?: WalletClient;
}

export interface ValidationReport {
  methods: Record<MethodName, string>;
  statusOrder: string[];
  abiPath: string;
}

export interface EncodedTransactionRequest {
  to: Address;
  data: Hex;
  value: 0n;
}

export interface RentCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly [bigint, number];
  value: 0n;
}

export interface ApproveCall {
  address: Address;
  abi: typeof ERC20_ABI;
  functionName: 'approve';
  args: readonly [Address, bigint];
  value: 0n;
}

export interface SettleCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly [bigint];
}

/**
 * Case-insensitive address equality check.
 */
export function areAddressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Formats atomic token amount into a human-readable decimal string using
 * verified token decimals.
 */
export function formatTokenAmount(amountAtomic: bigint, decimals: number): string {
  if (decimals < 0 || decimals > 36) {
    throw new Error(`Invalid decimals count: ${decimals}`);
  }
  const factor = 10n ** BigInt(decimals);
  const whole = amountAtomic / factor;
  const fraction = amountAtomic % factor;
  if (fraction === 0n) {
    return whole.toString();
  }
  const fracStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/**
 * Typed wrapper over the Stylus-exported `RentalManager` ABI and USDG token operations.
 */
export class RentalManagerClient {
  readonly config: ChainConfig;
  readonly abi: Abi;
  readonly status: StatusMapper;
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private readonly methodNames: Record<MethodName, string>;

  private constructor(config: ChainConfig, abi: Abi, status: StatusMapper) {
    this.config = config;
    this.abi = abi;
    this.status = status;
    this.methodNames = { ...DEFAULT_METHODS, ...(config.methodOverrides ?? {}) };

    this.publicClient =
      config.publicClientOverride ??
      createPublicClient({
        chain: defineChain({
          id: config.chainId,
          name: `chain-${config.chainId}`,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [config.rpcUrl] } },
        }),
        transport: http(config.rpcUrl, { retryCount: 3 }),
      });

    if (config.walletClientOverride) {
      this.walletClient = config.walletClientOverride;
    } else if (config.providerPrivateKey) {
      const account = privateKeyToAccount(config.providerPrivateKey);
      this.walletClient = createWalletClient({
        account,
        chain: this.publicClient.chain,
        transport: http(config.rpcUrl, { retryCount: 3 }),
      });
    }
  }

  /** Build and validate the client against the real ABI artifact. */
  static create(config: ChainConfig): RentalManagerClient {
    const abiPath = resolveAbiPath('RentalManager', {
      explicitPath: config.rentalManagerAbiPath,
      dir: config.abiDir,
    });
    const abi = loadAbi('RentalManager', {
      explicitPath: config.rentalManagerAbiPath,
      dir: config.abiDir,
    });
    const methods = { ...DEFAULT_METHODS, ...(config.methodOverrides ?? {}) };
    const available = new Set(abiFunctionNames(abi));
    const missingMethods = Object.entries(methods)
      .filter(([, name]) => !available.has(name))
      .map(([key, name]) => `${key} -> ${name}`);
    if (missingMethods.length > 0) {
      throw new Error(
        `RentalManager ABI at ${abiPath} is missing required methods: [${missingMethods.join(', ')}]. ` +
          `Available: [${[...available].join(', ')}].`,
      );
    }
    return new RentalManagerClient(config, abi, new StatusMapper(config.statusOrder?.split(',')));
  }

  get report(): ValidationReport {
    return {
      methods: { ...this.methodNames },
      statusOrder: [...this.status.orderList],
      abiPath: resolveAbiPath('RentalManager', {
        explicitPath: this.config.rentalManagerAbiPath,
        dir: this.config.abiDir,
      }),
    };
  }

  getMethod(name: MethodName): string {
    return this.methodNames[name];
  }

  get providerAddress(): Address | undefined {
    const addr = this.walletClient?.account?.address;
    return addr ? (addr.toLowerCase() as Address) : undefined;
  }

  get hasProviderWallet(): boolean {
    return Boolean(this.walletClient);
  }

  get client(): PublicClient {
    return this.publicClient;
  }

  // ---------------------------------------------------------------- reads

  private async read(functionName: MethodName, args: readonly unknown[]): Promise<unknown> {
    return this.publicClient.readContract({
      address: this.config.rentalManagerAddress as `0x${string}`,
      abi: this.abi as never,
      functionName: this.getMethod(functionName),
      args: args as never,
    });
  }

  /**
   * `paymentToken() view returns (address)`
   */
  async paymentToken(): Promise<Address> {
    const result = await this.read('paymentToken', []);
    return asAddress(result, 'paymentToken');
  }

  /**
   * `planCount() view returns (uint8)`
   */
  async planCount(): Promise<number> {
    const result = await this.read('planCount', []);
    return asNumber(result, 'planCount');
  }

  /**
   * `getPlan(uint8 planId) view returns (uint8,uint256,uint256,bool,bool)`
   */
  async getPlan(planId: number): Promise<ChainPlan> {
    const result = await this.read('getPlan', [planId]);
    return decodePlan(result, this.decodeOptions);
  }

  /**
   * `getNode(uint256 nodeId) view returns (uint256,address,bytes32,bool)`
   */
  async getNode(nodeId: bigint): Promise<ChainNode> {
    const result = await this.read('getNode', [nodeId]);
    return decodeNode(result, this.decodeOptions);
  }

  /**
   * `getListing(uint256 nodeId) view returns (uint256,address,bool)`
   */
  async getListing(nodeId: bigint): Promise<ChainListing> {
    const result = await this.read('getListing', [nodeId]);
    return decodeListing(result, this.decodeOptions);
  }

  /**
   * `getRental(uint256 rentalId)`. Returns `null` when the manager has no such rental
   * (e.g. getter reverts for unknown id).
   */
  async getRentalOrNull(rentalId: bigint): Promise<ChainRental | null> {
    let result: unknown;
    try {
      result = await this.read('getRental', [rentalId]);
    } catch (error) {
      // Only the contract's explicit RentalDoesNotExist(uint256) error means
      // absence. Transport, decode and unrelated contract failures propagate.
      const missingSelector = encodeFunctionData({
        abi: [{ type: 'function', name: 'RentalDoesNotExist', inputs: [{ type: 'uint256' }], outputs: [] }],
        functionName: 'RentalDoesNotExist', args: [rentalId],
      });
      let cause: unknown = error;
      for (let depth = 0; depth < 8 && typeof cause === 'object' && cause !== null; depth++) {
        const item = cause as { data?: unknown; cause?: unknown };
        if (item.data === missingSelector) return null;
        cause = item.cause;
      }
      throw error;
    }
    return this.toRental(result, rentalId);
  }

  async getRental(rentalId: bigint): Promise<ChainRental | null> {
    return this.getRentalOrNull(rentalId);
  }

  /**
   * Authoritative active-rental helper.
   *
   * Calls on-chain selector `activeRentalForNode(uint256 nodeId) view returns (bool, uint256)`.
   * Returns `null` only for `(false, 0)`.
   * Otherwise fetches and validates the referenced rental:
   *   - matching nodeId
   *   - status must be RESERVED or ACTIVE
   *
   * Fails closed on malformed tuples, impossible combinations, node/id mismatch,
   * non-active status, or RPC errors.
   */
  async getActiveRentalForNode(nodeId: bigint): Promise<ChainRental | null> {
    const result = await this.read('activeRentalForNode', [nodeId]);
    const [hasRental, rentalId] = decodeActiveRentalForNode(result);

    if (!hasRental && rentalId === 0n) {
      return null;
    }

    if (!hasRental || rentalId === 0n) {
      throw new Error(
        `activeRentalForNode returned contradictory state for node ${nodeId}: hasRental=${hasRental}, rentalId=${rentalId}`,
      );
    }

    const rental = await this.getRentalOrNull(rentalId);
    if (!rental) {
      throw new Error(
        `Active rental ${rentalId} referenced by node ${nodeId} was not found on chain.`,
      );
    }

    if (rental.nodeId !== nodeId) {
      throw new Error(
        `Active rental ${rentalId} node ID mismatch: expected node ${nodeId}, found node ${rental.nodeId}.`,
      );
    }

    if (rental.status !== 'RESERVED' && rental.status !== 'ACTIVE') {
      throw new Error(
        `Active rental ${rentalId} has terminal or unexpected status: ${rental.status}.`,
      );
    }

    return rental;
  }

  /**
   * Evaluates renter eligibility per ledger §4:
   * Node active AND listing active AND no active rental AND selected plan active.
   */
  async isNodeRentable(
    nodeId: bigint,
    planId: number,
  ): Promise<{ eligible: boolean; reason?: string }> {
    const [node, listing, activeRental, plan] = await Promise.all([
      this.getNode(nodeId),
      this.getListing(nodeId),
      this.getActiveRentalForNode(nodeId),
      this.getPlan(planId),
    ]);

    if (!node.active) {
      return { eligible: false, reason: `Node ${nodeId} is inactive` };
    }
    if (!listing.active) {
      return { eligible: false, reason: `Listing for node ${nodeId} is inactive` };
    }
    if (activeRental !== null) {
      return {
        eligible: false,
        reason: `Node ${nodeId} already has an active or reserved rental (${activeRental.rentalId})`,
      };
    }
    if (!plan.active) {
      return { eligible: false, reason: `Plan ${planId} is inactive` };
    }

    return { eligible: true };
  }

  /**
   * True when `address` holds no deployed bytecode (EOA).
   */
  async isEoa(address: string): Promise<boolean> {
    const code = await this.publicClient.getCode({ address: address as `0x${string}` });
    return code === undefined || code === '0x';
  }

  async rentalExists(rentalId: bigint): Promise<boolean> {
    return (await this.getRentalOrNull(rentalId)) !== null;
  }

  // ---------------------------------------------------------------- ERC-20 payment token helpers

  /**
   * Reads ERC-20 metadata from the payment token contract.
   */
  async getPaymentTokenMetadata(tokenAddress?: Address): Promise<PaymentTokenMetadata> {
    const address = tokenAddress ?? (await this.paymentToken());
    const [decimalsRaw, symbolRaw] = await Promise.all([
      this.publicClient.readContract({
        address,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
      this.publicClient.readContract({
        address,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }),
    ]);

    return {
      address: asAddress(address, 'tokenAddress'),
      decimals: asNumber(decimalsRaw, 'decimals'),
      symbol: asString(symbolRaw, 'symbol'),
    };
  }

  /**
   * Reads ERC-20 token balance for account.
   */
  async getTokenBalance(account: Address, tokenAddress?: Address): Promise<bigint> {
    const address = tokenAddress ?? (await this.paymentToken());
    const balance = await this.publicClient.readContract({
      address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account],
    });
    return asBigInt(balance, 'balanceOf');
  }

  /**
   * Reads ERC-20 token allowance.
   */
  async getTokenAllowance(
    owner: Address,
    spender?: Address,
    tokenAddress?: Address,
  ): Promise<bigint> {
    const address = tokenAddress ?? (await this.paymentToken());
    const actualSpender = spender ?? asAddress(this.config.rentalManagerAddress, 'spender');
    const allowance = await this.publicClient.readContract({
      address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, actualSpender],
    });
    return asBigInt(allowance, 'allowance');
  }

  /**
   * Builds an ERC-20 approval call descriptor for wallet execution.
   */
  buildApproveCall(
    spender: Address,
    amountAtomic: bigint,
    tokenAddress?: Address,
  ): ApproveCall {
    const address = tokenAddress ?? asAddress(this.config.paymentTokenAddress ?? '', 'paymentTokenAddress');
    return {
      address,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, amountAtomic],
      value: 0n,
    };
  }

  /**
   * Reads the authoritative current block timestamp from the connected RPC node.
   */
  async getBlockTimestamp(): Promise<bigint> {
    const block = await this.publicClient.getBlock();
    return block.timestamp;
  }

  // --------------------------------------------------------------- writes

  /** Provider-side call made automatically once the reservation is healthy. */
  async startRental(rentalId: bigint): Promise<Hex> {
    if (!this.walletClient) {
      throw new Error('Provider wallet is not configured; PROVIDER_PRIVATE_KEY is required to start a rental.');
    }
    if (await this.publicClient.getChainId() !== 46630) throw new Error('Provider RPC is on the wrong chain.');
    const rental = await this.getRental(rentalId);
    if (!rental || rental.nodeId !== 1n || rental.status !== 'RESERVED') throw new Error('Rental is no longer RESERVED on Node 1.');
    if (this.providerAddress?.toLowerCase() !== rental.provider.toLowerCase()) throw new Error('Provider signer does not match the frozen provider.');
    const block = await this.publicClient.getBlock();
    if (block.timestamp >= rental.startDeadline) throw new Error('Start deadline has been reached.');
    await this.publicClient.simulateContract({
      address: this.config.rentalManagerAddress as `0x${string}`, abi: this.abi as never,
      functionName: this.getMethod('startRental'), args: [rentalId] as never,
      account: this.walletClient.account!,
    });
    const hash = await this.walletClient.writeContract({
      address: this.config.rentalManagerAddress as `0x${string}`,
      abi: this.abi as never,
      functionName: this.getMethod('startRental'),
      args: [rentalId] as never,
      account: this.walletClient.account!,
      chain: this.walletClient.chain,
    });
    await this.waitForTransactionSuccess(hash);
    return hash;
  }

  /**
   * Validates and submits an exact canonical EncodedTransactionRequest.
   * Enforces that request.to matches RentalManager, request.value === 0n,
   * calldata decodes strictly to settleAfterExpiry(uint256) with valid rentalId,
   * provider wallet is configured, and RPC is on chain 46630.
   * Simulates the call before sending the transaction.
   * Returns the transaction hash without waiting for confirmation.
   */
  async submitTransaction(
    request: EncodedTransactionRequest,
    options?: { nonce?: number },
  ): Promise<Hex> {
    if (!this.walletClient) {
      throw new Error('Transaction signer is not configured; PROVIDER_PRIVATE_KEY is required to settle a rental.');
    }
    if ((await this.publicClient.getChainId()) !== 46630) {
      throw new Error('Provider RPC is on the wrong chain.');
    }
    if (!request.to || request.to.toLowerCase() !== this.config.rentalManagerAddress.toLowerCase()) {
      throw new Error(
        `Transaction target ${request.to} does not match configured RentalManager address ${this.config.rentalManagerAddress}`,
      );
    }
    if (request.value !== 0n) {
      throw new Error('Settlement transaction must be nonpayable.');
    }
    if (typeof request.data !== 'string' || !request.data.startsWith('0x') || request.data.length !== 74) {
      throw new Error('Transaction calldata must be exactly 36 bytes (4-byte selector and 32-byte argument).');
    }

    let decoded: { functionName: string; args?: readonly unknown[] };
    try {
      decoded = decodeFunctionData({
        abi: this.abi as Abi,
        data: request.data,
      });
    } catch {
      throw new Error('Transaction calldata could not be decoded with RentalManager ABI.');
    }

    if (decoded.functionName !== this.getMethod('settleAfterExpiry')) {
      throw new Error(`Unexpected function call ${decoded.functionName}, expected settleAfterExpiry`);
    }
    if (!decoded.args || decoded.args.length !== 1 || typeof decoded.args[0] !== 'bigint') {
      throw new Error('Malformed settleAfterExpiry arguments');
    }
    const decodedRentalId = decoded.args[0] as bigint;
    if (decodedRentalId <= 0n) {
      throw new Error('rentalId must be a positive integer');
    }

    // Simulate the same raw request that will be submitted. Re-encoding a
    // decoded function call here would create two transaction representations
    // and weaken the exact-forwarding boundary.
    await this.publicClient.call({
      to: request.to as `0x${string}`,
      data: request.data,
      value: request.value,
      account: this.walletClient.account!,
    });
    if (typeof this.walletClient.sendTransaction !== 'function') {
      throw new Error(
        'walletClient.sendTransaction is required to submit the exact encoded transaction request.',
      );
    }
    return await this.walletClient.sendTransaction({
      to: request.to as `0x${string}`,
      data: request.data,
      value: request.value,
      account: this.walletClient.account!,
      chain: this.walletClient.chain,
      ...(options?.nonce !== undefined ? { nonce: options.nonce } : {}),
    });
  }

  /**
   * Returns the transaction count (nonce) for an account.
   */
  async getTransactionCount(
    address: Address,
    blockTag: 'latest' | 'pending' = 'pending',
  ): Promise<number> {
    return this.publicClient.getTransactionCount({
      address: address as `0x${string}`,
      blockTag,
    });
  }

  /**
   * Preflights and submits a permissionless `settleAfterExpiry(uint256 rentalId)` transaction.
   * Returns the transaction hash without waiting for confirmation.
   */
  async submitSettleAfterExpiry(rentalId: bigint): Promise<Hex> {
    if (!this.walletClient) {
      throw new Error('Transaction signer is not configured; PROVIDER_PRIVATE_KEY is required to settle a rental.');
    }
    if ((await this.publicClient.getChainId()) !== 46630) {
      throw new Error('Provider RPC is on the wrong chain.');
    }
    const rental = await this.getRental(rentalId);
    if (!rental || rental.nodeId !== (this.config.nodeId ?? 1n) || rental.status !== 'ACTIVE') {
      throw new Error(`Rental is no longer ACTIVE on Node ${this.config.nodeId ?? 1n}.`);
    }
    const block = await this.publicClient.getBlock();
    if (rental.expiresAt === 0n || block.timestamp < rental.expiresAt) {
      throw new Error('Rental has not reached its expiry.');
    }
    const encoded = this.encodeSettleAfterExpiryCalldata(rentalId);
    return this.submitTransaction(encoded);
  }

  /**
   * Submits a `settleAfterExpiry(uint256 rentalId)` transaction and waits for its mined success receipt.
   * Fails closed on simulation failure or reverted transaction.
   */
  async settleAfterExpiry(rentalId: bigint): Promise<Hex> {
    const hash = await this.submitSettleAfterExpiry(rentalId);
    await this.waitForTransactionSuccess(hash);
    return hash;
  }

  /**
   * Call descriptor for the renter's wallet: `rent(uint256 nodeId, uint8 planId)`.
   * Nonpayable — no native ETH value.
   */
  buildRentCall(nodeId: bigint, planId: number): RentCall {
    return {
      address: asAddress(this.config.rentalManagerAddress, 'rentalManagerAddress'),
      abi: this.abi,
      functionName: this.getMethod('rent'),
      args: [nodeId, planId],
      value: 0n,
    };
  }

  buildCancelCall(rentalId: bigint): SettleCall {
    return {
      address: asAddress(this.config.rentalManagerAddress, 'rentalManagerAddress'),
      abi: this.abi,
      functionName: this.getMethod('cancelExpiredReservation'),
      args: [rentalId],
    };
  }

  buildSettleCall(rentalId: bigint): SettleCall {
    return {
      address: asAddress(this.config.rentalManagerAddress, 'rentalManagerAddress'),
      abi: this.abi,
      functionName: this.getMethod('settleAfterExpiry'),
      args: [rentalId],
    };
  }

  // --------------------------------------------------------------- calldata encoders

  /**
   * Encodes an ERC-20 approval transaction request.
   *
   * @param spender Address permitted to spend tokens (typically RentalManager)
   * @param amountAtomic Exact atomic amount to approve (e.g. 100_000n for Plan 0)
   * @param tokenAddress Optional payment token address; defaults to configured paymentTokenAddress
   * @returns Typed transaction request with to = token address, data = ABI-encoded approve(spender, amount), value = 0n
   */
  encodeApproveCalldata(
    spender: string,
    amountAtomic: bigint,
    tokenAddress?: string,
  ): EncodedTransactionRequest {
    const targetToken = asAddress(
      tokenAddress ?? this.config.paymentTokenAddress ?? '',
      'paymentTokenAddress',
    );
    const validSpender = asAddress(spender, 'spender');
    if (amountAtomic < 0n) {
      throw new RangeError(`Field "amountAtomic" cannot be negative: ${amountAtomic}`);
    }
    const amount = asBigInt(amountAtomic, 'amountAtomic');
    const MAX_UINT256 = (1n << 256n) - 1n;
    if (amount > MAX_UINT256) {
      throw new RangeError(`Field "amountAtomic" exceeds uint256 max: ${amount}`);
    }

    const hasApprove = ERC20_ABI.some(
      (item) => item.type === 'function' && item.name === 'approve',
    );
    if (!hasApprove) {
      throw new Error('Cannot encode approve calldata: "approve" function not found in ERC20_ABI.');
    }

    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [validSpender, amount],
    });

    return {
      to: targetToken,
      data,
      value: 0n,
    };
  }

  /**
   * Encodes a RentalManager `rent(uint256 nodeId, uint8 planId)` transaction request.
   *
   * @param nodeId Node ID to rent (must be a positive integer)
   * @param planId Selected plan ID (must be a valid uint8, 0..255)
   * @returns Typed transaction request with to = RentalManager address, data = ABI-encoded rent(nodeId, planId), value = 0n
   */
  encodeRentCalldata(
    nodeId: bigint,
    planId: number,
  ): EncodedTransactionRequest {
    const to = asAddress(this.config.rentalManagerAddress, 'rentalManagerAddress');
    if (nodeId <= 0n) {
      throw new RangeError(`Field "nodeId" must be a positive integer: ${nodeId}`);
    }
    const validNodeId = asBigInt(nodeId, 'nodeId');
    const MAX_UINT256 = (1n << 256n) - 1n;
    if (validNodeId > MAX_UINT256) {
      throw new RangeError(`Field "nodeId" exceeds uint256 max: ${validNodeId}`);
    }

    if (planId < 0 || planId > 255) {
      throw new RangeError(`Field "planId" must be a uint8 between 0 and 255: ${planId}`);
    }
    const validPlanId = asNumber(planId, 'planId');

    const functionName = this.getMethod('rent');
    const hasFunc = (this.abi as readonly { type?: string; name?: string }[]).some(
      (item) => item.type === 'function' && item.name === functionName,
    );
    if (!hasFunc) {
      throw new Error(
        `Cannot encode rent calldata: method "${functionName}" is not present in RentalManager ABI.`,
      );
    }

    const data = encodeFunctionData({
      abi: this.abi,
      functionName,
      args: [validNodeId, validPlanId],
    } as any);

    return {
      to,
      data,
      value: 0n,
    };
  }

  /**
   * Encodes a RentalManager `cancelExpiredReservation(uint256 rentalId)` transaction request.
   *
   * @param rentalId Rental ID to cancel (must be a positive integer)
   * @returns Typed transaction request with to = RentalManager address, data = ABI-encoded cancelExpiredReservation(rentalId), value = 0n
   */
  encodeCancelExpiredReservationCalldata(
    rentalId: bigint,
  ): EncodedTransactionRequest {
    const to = asAddress(this.config.rentalManagerAddress, 'rentalManagerAddress');
    if (rentalId <= 0n) {
      throw new RangeError(`Field "rentalId" must be a positive integer: ${rentalId}`);
    }
    const validRentalId = asBigInt(rentalId, 'rentalId');
    const MAX_UINT256 = (1n << 256n) - 1n;
    if (validRentalId > MAX_UINT256) {
      throw new RangeError(`Field "rentalId" exceeds uint256 max: ${validRentalId}`);
    }

    const functionName = this.getMethod('cancelExpiredReservation');
    const hasFunc = (this.abi as readonly { type?: string; name?: string }[]).some(
      (item) => item.type === 'function' && item.name === functionName,
    );
    if (!hasFunc) {
      throw new Error(
        `Cannot encode cancelExpiredReservation calldata: method "${functionName}" is not present in RentalManager ABI.`,
      );
    }

    const data = encodeFunctionData({
      abi: this.abi,
      functionName,
      args: [validRentalId],
    } as any);

    return {
      to,
      data,
      value: 0n,
    };
  }

  /**
   * Encodes a RentalManager `settleAfterExpiry(uint256 rentalId)` transaction request.
   *
   * @param rentalId Rental ID to settle (must be a positive integer)
   * @returns Typed transaction request with to = RentalManager address, data = ABI-encoded settleAfterExpiry(rentalId), value = 0n
   */
  encodeSettleAfterExpiryCalldata(
    rentalId: bigint,
  ): EncodedTransactionRequest {
    const to = asAddress(this.config.rentalManagerAddress, 'rentalManagerAddress');
    if (rentalId <= 0n) {
      throw new RangeError(`Field "rentalId" must be a positive integer: ${rentalId}`);
    }
    const validRentalId = asBigInt(rentalId, 'rentalId');
    const MAX_UINT256 = (1n << 256n) - 1n;
    if (validRentalId > MAX_UINT256) {
      throw new RangeError(`Field "rentalId" exceeds uint256 max: ${validRentalId}`);
    }

    const functionName = this.getMethod('settleAfterExpiry');
    const hasFunc = (this.abi as readonly { type?: string; name?: string }[]).some(
      (item) => item.type === 'function' && item.name === functionName,
    );
    if (!hasFunc) {
      throw new Error(
        `Cannot encode settleAfterExpiry calldata: method "${functionName}" is not present in RentalManager ABI.`,
      );
    }

    const data = encodeFunctionData({
      abi: this.abi,
      functionName,
      args: [validRentalId],
    } as any);

    return {
      to,
      data,
      value: 0n,
    };
  }

  /**
   * Alias for encodeCancelExpiredReservationCalldata.
   */
  encodeCancelCalldata(rentalId: bigint): EncodedTransactionRequest {
    return this.encodeCancelExpiredReservationCalldata(rentalId);
  }

  /**
   * Alias for encodeSettleAfterExpiryCalldata.
   */
  encodeSettleCalldata(rentalId: bigint): EncodedTransactionRequest {
    return this.encodeSettleAfterExpiryCalldata(rentalId);
  }

  /**
   * Waits for a transaction receipt and verifies receipt status === 'success'.
   * Fails closed on reverted or failed transaction.
   */
  async waitForTransactionSuccess(hash: Hex): Promise<TransactionReceipt> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`Transaction ${hash} reverted or failed onchain (status: ${receipt.status}).`);
    }
    return receipt;
  }

  explorerTx(hash: string): string | undefined {
    if (!this.config.explorerUrl) return undefined;
    return `${this.config.explorerUrl.replace(/\/$/, '')}/tx/${hash}`;
  }

  private get decodeOptions(): DecodeOptions {
    return {
      status: this.status,
      rentalFieldsOrder: this.config.rentalFieldsOrder,
      nodeFieldsOrder: this.config.nodeFieldsOrder,
      listingFieldsOrder: this.config.listingFieldsOrder,
      planFieldsOrder: this.config.planFieldsOrder,
    };
  }

  private toRental(result: unknown, fallbackId?: bigint): ChainRental {
    const raw = isRecord(result) ? (result as Record<string, unknown>) : {};
    const rental = decodeRental(result, raw, this.decodeOptions);
    if (rental.rentalId <= 0n || (fallbackId !== undefined && rental.rentalId !== fallbackId)) {
      throw new Error('getRental returned an invalid or mismatched rental ID.');
    }
    return rental;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ----------------------------------------------------------------- standalone encoders

export function encodeApproveCalldata(
  client: RentalManagerClient,
  spender: string,
  amountAtomic: bigint,
  tokenAddress?: string,
): EncodedTransactionRequest {
  return client.encodeApproveCalldata(spender, amountAtomic, tokenAddress);
}

export function encodeRentCalldata(
  client: RentalManagerClient,
  nodeId: bigint,
  planId: number,
): EncodedTransactionRequest {
  return client.encodeRentCalldata(nodeId, planId);
}

export function encodeCancelExpiredReservationCalldata(
  client: RentalManagerClient,
  rentalId: bigint,
): EncodedTransactionRequest {
  return client.encodeCancelExpiredReservationCalldata(rentalId);
}

export function encodeSettleAfterExpiryCalldata(
  client: RentalManagerClient,
  rentalId: bigint,
): EncodedTransactionRequest {
  return client.encodeSettleAfterExpiryCalldata(rentalId);
}

export function encodeCancelCalldata(
  client: RentalManagerClient,
  rentalId: bigint,
): EncodedTransactionRequest {
  return client.encodeCancelExpiredReservationCalldata(rentalId);
}

export function encodeSettleCalldata(
  client: RentalManagerClient,
  rentalId: bigint,
): EncodedTransactionRequest {
  return client.encodeSettleAfterExpiryCalldata(rentalId);
}
