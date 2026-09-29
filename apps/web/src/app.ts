/**
 * Renter controller: wires the wallet, the chain, the Agent session and the
 * inference stream into one state the page renders.
 *
 * The page calls methods and re-renders from the `state` object every mutation
 * refreshes. That is what makes "send transaction → wait for receipt → refresh"
 * a single path, instead of a hand-written sequence inside each button handler
 * where one of them eventually forgets the refresh.
 *
 * Two invariants the controller holds on its own:
 *
 * 1. **Identity change drops the session first.** A new account, a new chain, or
 *    a disconnect revokes the token immediately, before anything else happens.
 * 2. **Nothing survives a transaction un-refreshed.** After every write the
 *    rental is re-read and the buttons come from the refreshed state, so a
 *    reservation that expired while the tab sat idle is not offered as live.
 */

import {
  AgentError,
  agentOrigin,
  fetchConfig,
  fetchHealth,
  isSessionDead,
  parseGpu,
  parseNode,
  type AgentConfig,
  type AgentHealth,
  type AgentNode,
  type GpuStatus,
} from './agentClient';
import { CHAIN_ID, ConfigError, RpcError, type AbiFunctionEntry } from './config';
import { authenticate, AuthError, isSessionDead as authIsSessionDead, SessionStore } from './auth';
import { isAccessible, isNone, isTerminal, lifecycleStage } from './rentalState';
import {
  USDG_DECIMALS_EXPECTED,
  USDG_SYMBOL,
  type ChainRental,
} from './chainPure';
import { RentalManagerClient } from '@archcore/chain';
import {
  RentalReader,
  readPaymentToken,
  type PaymentTokenView,
  type PlanView,
  type RentQuote,
  RentalOpsError,
  cancelExpiredReservation as sendCancel,
  rent,
  approveRental,
  settleAfterExpiry as sendSettle,
  statusMapper,
} from './rentalOps';
import { InferenceError, streamInference, isSessionDead as inferenceSessionDead } from './inference';
import { SseError } from './sse';
import { ChatView, type Turn } from './render';
import {
  connectWallet,
  detectProvider,
  ensureChain,
  onWalletChanged,
  readChainId,
  WalletError,
  type Eip1193Provider,
  type WalletState,
} from './wallet';

/** Everything the page renders, refreshed after every mutation. */
export interface AppState {
  health: AgentHealth | null;
  node: AgentNode | null;
  gpu: GpuStatus | null;
  config: AgentConfig | null;
  abi: readonly AbiFunctionEntry[] | null;

  wallet: WalletState | null;
  /** The injected provider, pinned so every send uses the one that connected. */
  provider: Eip1193Provider | null;
  account: string | null;

  /** What a rental costs right now, as the chain reported it. */
  quote: RentQuote | null;
  rental: ChainRental | null;

  /**
   * The contract's rental-plan catalog, read once per chain reload.
   *
   * A plan the renter picked is `selectedPlanId`; the catalog it picked from is
   * contract state, so the page offers what the manager actually lists rather
   * than a hardcoded table that could disagree with it.
   */
  plans: readonly PlanView[];
  /** Plan the rent button acts on. Defaults to the demo plan when one exists. */
  selectedPlanId: number | null;
  /** The payment token's own metadata and this renter's position in it. */
  payment: PaymentTokenView | null;
  /** Native ETH is gas only; null means not verified, never a fabricated balance. */
  gasBalance: bigint | null;
  chainReady: boolean;
  notice: string | null;

  /** Set once the wallet's account holds a session for the current rental. */
  authenticatedFor: bigint | null;
  authError: string | null;
  streaming: boolean;
  inferenceOutput: string;
  error: string | null;
  busy: string | null;
}

function initialState(): AppState {
  return {
    health: null,
    node: null,
    gpu: null,
    config: null,
    abi: null,

    wallet: null,
    provider: null,
    account: null,

    quote: null,
    rental: null,

    plans: [],
    selectedPlanId: null,
    payment: null,
    gasBalance: null,
    chainReady: false,
    notice: null,

    authenticatedFor: null,
    authError: null,
    streaming: false,
    inferenceOutput: '',
    error: null,
    busy: null,
  };
}

const TICK_MS = 1000;

/**
 * Decides which plan a page read should act on.
 *
 * The renter's last choice wins while the contract still lists it, so a refresh
 * does not silently move them onto a different rental. When it does not — a
 * first load, or a plan the manager has since retired — the demo plan is the
 * default because it exercises the compressed testnet lifecycle (0.10 USDG);
 * if the catalog has no demo plan, the first active plan is used, and a catalog
 * with nothing active selects nothing, which the UI reports rather than hides.
 */
function pickPlanId(plans: readonly PlanView[], current: number | null): number | null {
  if (current !== null && plans.some((plan) => plan.planId === current && plan.active)) {
    return current;
  }
  const active = plans.filter((plan) => plan.active);
  const demo = active.find((plan) => plan.demoOnly);
  return demo?.planId ?? active[0]?.planId ?? null;
}

export interface RenterAppOptions {
  reconcileDelayMs?: number;
  reconcileMaxAttempts?: number;
}

export class RenterApp {
  state: AppState = initialState();

  /** The draft the prompt field holds, so a re-render never eats typing. */
  draftPrompt = '';

  /** The transcript turns, appended here rather than in the page. */
  readonly turns: Turn[] = [];

  private readonly origin: string;
  private readonly sessionStore = new SessionStore();
  private reader: RentalReader | null = null;
  private unsubscribe: (() => void) | null = null;
  private inferenceController: AbortController | null = null;
  /** Claimed for the length of a value-bearing send, so a second click cannot double it. */
  private sending = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reloading = false;
  private reloadDone: Promise<void> = Promise.resolve();
  private authPending = false;
  private autoAuthAttempted = new Set<string>();
  private currentRentalId: bigint | null = null;
  private identityVersion = 0;
  private reconcileDelayMs = 1000;
  private reconcileMaxAttempts = 10;
  private chainReadGeneration = 0;
  private lastAppliedChainGeneration = 0;
  private reconcileGeneration = 0;
  private activeReconciliation: { rentalId: bigint; generation: number } | null = null;
  private chat: ChatView | null = null;
  private listeners = new Set<(state: AppState) => void>();

  constructor(
    private readonly location: { hostname: string; origin: string; search: string },
    options?: RenterAppOptions,
  ) {
    this.origin = agentOrigin(location);
    if (options?.reconcileDelayMs !== undefined) this.reconcileDelayMs = options.reconcileDelayMs;
    if (options?.reconcileMaxAttempts !== undefined) this.reconcileMaxAttempts = options.reconcileMaxAttempts;
  }

  isAuthRunning(): boolean {
    return this.authPending;
  }

  isReconciling(): boolean {
    return this.activeReconciliation !== null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private clearAutoAuthState(): void {
    this.autoAuthAttempted.clear();
  }

  /**
   * Preconditions for auto-authentication:
   * 1. wallet is connected
   * 2. wallet chain is 46630
   * 3. a current rental exists
   * 4. rental status is ACTIVE
   * 5. rental has not expired according to current time
   * 6. connected wallet equals rental.renter
   * 7. no valid session exists
   * 8. no authentication request is already running
   */
  private canAutoAuthenticate(): boolean {
    const { wallet, account, provider, rental } = this.state;
    if (!wallet || !account || !provider) return false;
    if (wallet.chainId !== CHAIN_ID) return false;
    if (!rental || rental.status === 'NONE') return false;
    if (rental.status !== 'ACTIVE') return false;
    if (!isAccessible(rental, Date.now())) return false;
    if (account.toLowerCase() !== rental.renter.toLowerCase()) return false;
    const held = this.sessionStore.session;
    if (held !== null && !this.sessionStore.isExpired() && held.rentalId === rental.rentalId) {
      return false;
    }
    if (this.authPending) return false;
    return true;
  }

  tryAutoAuthenticate(): void {
    if (!this.canAutoAuthenticate()) return;
    const rental = this.state.rental!;
    const account = this.state.account!;
    const tupleKey = `${rental.rentalId}:${account.toLowerCase()}:${this.origin}`;
    if (this.autoAuthAttempted.has(tupleKey)) return;
    this.autoAuthAttempted.add(tupleKey);
    void this.login();
  }

  /** Boots: load config and the artifact, read the chain, start the ticker. */
  async start(): Promise<void> {
    if (this.timer !== null) return;
    this.emit();
    await this.reloadConfig();
    if (this.state.config) {
      await this.reloadChain();
      await this.refreshHealth();
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.pollTimer = setInterval(() => {
      if (!this.sending && !this.authPending && (!this.state.busy || this.isReconciling())) {
        void this.reloadChain(true);
      }
    }, 5000);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.identityVersion++;
    this.reconcileGeneration++;
    this.activeReconciliation = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dropSession();
    this.clearAutoAuthState();
    this.emitPatch({ authenticatedFor: null, busy: null, authError: null });
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private emitPatch(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private fail(message: string): void {
    this.emitPatch({ error: message, busy: null });
  }

  /** Turns any thrown value into one readable message, without hiding type. */
  private describe(error: unknown): string {
    if (
      error instanceof WalletError
      || error instanceof RentalOpsError
      || error instanceof AgentError
      || error instanceof ConfigError
      || error instanceof AuthError
      || error instanceof InferenceError
      || error instanceof SseError
      || error instanceof RpcError
    ) {
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Drops the session and any stream riding it, in one place.
   *
   * Revocation without aborting used to be spelled out at each call site, which
   * is how one of them eventually forgot the abort: the wallet event killed the
   * token while the in-flight request kept streaming against a session the Agent
   * was no longer bound to honour. Every revocation path now runs this, so a new
   * one cannot forget half of it.
   */
  private dropSession(): void {
    this.sessionStore.revoke();
    this.inferenceController?.abort();
  }

  /** Drops the session when the Agent says it is dead. */
  private guardSession(error: unknown): boolean {
    if (isSessionDead(error) || authIsSessionDead(error) || inferenceSessionDead(error)) {
      this.dropSession();
      this.emitPatch({ authenticatedFor: null });
      return true;
    }
    return false;
  }

  /**
   * Drops the session when the rental in play is no longer the one it was
   * issued for.
   *
   * A `rent`, a cancel, or a settle moves the node onto a different rental id,
   * and a refresh that comes back with no rental at all is the same news by a
   * slower route. Either way the token names a rental the chain no longer
   * reports, so it is revoked here rather than left to expire on its own — and
   * the stream riding it stops with it, because every remaining frame would be
   * answered with a 401 or a 409.
   *
   * Returns whether it revoked, so the caller can clear `authenticatedFor` in
   * the same emit rather than re-render a session that is already gone.
   */
  private dropSessionIfRentalChanged(rental: ChainRental | null): boolean {
    const held = this.sessionStore.session;
    if (held && (!rental || held.rentalId !== rental.rentalId || !isAccessible(rental, Date.now()))) {
      this.dropSession();
      return true;
    }
    return false;
  }

  /** Claims the wallet-send slot, refusing a send while one is already open. */
  private claimSend(): boolean {
    if (this.sending) return false;
    this.sending = true;
    return true;
  }

  private requireConfig(): AgentConfig {
    const config = this.state.config;
    if (!config) throw new AppError('Agent configuration has not loaded.');
    return config;
  }

  private requireAccount(): string {
    const account = this.state.account;
    if (!account) throw new WalletError('Connect a wallet first.');
    return account;
  }

  private requireProvider(): Eip1193Provider {
    const provider = this.state.provider;
    if (!provider) throw new WalletError('Connect a wallet first.');
    return provider;
  }

  private requireReader(): RentalReader {
    const reader = this.reader;
    if (!reader) throw new AppError('The chain reader is not ready.');
    return reader;
  }

  /**
   * Decimals the payment token reports, or USDG's expected ones.
   *
   * The token's own reading wins once it has been read, because a token that
   * moves somewhere other than 6 leaves every price on the page wrong by orders
   * of magnitude. Before that read, and when no wallet is connected, the frozen
   * expectation is used — it is the same figure the Agent validates the token
   * against, so it is only ever a fallback for the moment before the chain
   * answered.
   */
  paymentDecimals(): number {
    return this.state.payment?.decimals ?? this.state.config?.paymentDecimals ?? USDG_DECIMALS_EXPECTED;
  }

  /** The payment token's symbol, for display only. */
  paymentSymbol(): string {
    return this.state.payment?.symbol ?? this.state.config?.paymentSymbol ?? USDG_SYMBOL;
  }
  /**
   * Loads public Agent configuration and the ABI validated by RentalManagerClient.
   * ABI loading/validation belongs to `@archcore/chain`; Web consumes the
   * client's validated ABI and normalized methods instead of fetching or
   * maintaining an independent artifact copy.
   */
  async reloadConfig(): Promise<void> {
    this.emitPatch({ busy: 'Loading agent configuration…' });
    try {
      const config = await fetchConfig(this.origin);

      const client = RentalManagerClient.create({
        chainId: config.chainId,
        rpcUrl: config.rpcUrl,
        rentalManagerAddress: config.rentalManagerAddress,
        paymentTokenAddress: config.paymentToken,
        nodeId: config.nodeId,
        explorerUrl: config.explorerUrl,
      });
      this.reader = new RentalReader(client);
      this.emitPatch({
        config,
        abi: client.abi as unknown as readonly AbiFunctionEntry[],
        busy: null,
        error: null,
      });
    } catch (error) {
      this.fail(this.describe(error));
    }
  }

  /** Re-reads the node, its listing, the plan catalog, and the rental in play. */
  async reloadChain(background = false): Promise<void> {
    if (!this.state.config || !this.reader) return;
    if (this.reloading) {
      if (background) return;
      await this.reloadDone;
      return this.reloadChain(false);
    }
    this.reloading = true;
    let finishReload!: () => void;
    this.reloadDone = new Promise<void>((resolve) => { finishReload = resolve; });
    const identity = this.identityVersion;
    const readGen = ++this.chainReadGeneration;
    if (!background) this.emitPatch({ busy: 'Reading chain…' });
    try {
      const reader = this.requireReader();
      const config = this.requireConfig();
      const [plans, node] = await Promise.all([
        // The plan catalog is contract state: the page offers the plans the
        // manager actually lists, in its own order, so a renamed or retired plan
        // cannot leave the renter staring at a price the chain disagrees with.
        reader.listPlans(),
        // `/node` is the Agent's own view of its listing, so it is the slot that
        // may legitimately be missing: the contract still answers for the price,
        // the duration and the rental, and a blank node panel is honest where an
        // unusable page is not.
        this.callNode(),
      ]);
      // A plan the renter already picked stays picked across a refresh, unless
      // the contract stopped listing it — then the selection is re-derived rather
      // than left pointing at a plan `getPlan` would refuse.
      const selectedPlanId = pickPlanId(plans, this.state.selectedPlanId);
      // A catalog with no active plan cannot be rented from, and the panel says
      // so: `quote` holds null until one exists, rather than a price the renter
      // would be asked to send for a plan the manager refuses.
      const [quote, rental] = await Promise.all([
        selectedPlanId === null
          ? Promise.resolve(null)
          : reader.quoteRent(config.nodeId, selectedPlanId),
        this.resolveCurrentRental(reader),
      ]);
      const payment = this.state.account && config.paymentToken
        ? await readPaymentToken(
          reader.client,
          this.state.account,
          config.paymentToken,
          config.rentalManagerAddress,
        )
        : this.state.payment;
      const gasBalance = this.state.account
        ? await reader.client.client.getBalance({ address: this.state.account as `0x${string}` }).catch(() => null)
        : null;
      if (identity !== this.identityVersion) return;
      if (readGen < this.lastAppliedChainGeneration) return;

      let effectiveRental = rental;
      if (
        this.state.rental &&
        isTerminal(this.state.rental) &&
        effectiveRental.rentalId === this.state.rental.rentalId &&
        !isTerminal(effectiveRental)
      ) {
        effectiveRental = this.state.rental;
      }

      this.lastAppliedChainGeneration = readGen;

      const newRentalId = effectiveRental && effectiveRental.status !== 'NONE' ? effectiveRental.rentalId : null;
      if (this.currentRentalId !== newRentalId) {
        this.clearAutoAuthState();
        this.currentRentalId = newRentalId;
        this.state = { ...this.state, authError: null };
      }
      if (isTerminal(effectiveRental)) {
        this.clearAutoAuthState();
        this.state = { ...this.state, authError: null };
      }
      if (effectiveRental.status === 'ACTIVE' && !isAccessible(effectiveRental, Date.now())) {
        this.clearAutoAuthState();
        this.state = { ...this.state, authError: null };
      }
      // Retain the terminal receipt's rental for the lifecycle/history panel
      // while allowing a fresh quote to release the checkout controls.
      const displayRental = effectiveRental.status === 'NONE' && this.state.rental
        && isTerminal(this.state.rental) ? this.state.rental : effectiveRental;
      const revoked = this.dropSessionIfRentalChanged(displayRental);
      this.emitPatch({
        node,
        plans,
        selectedPlanId,
        quote,
        payment,
        rental: displayRental,
        gasBalance,
        chainReady: true,
        ...(background ? {} : { busy: null, error: null }),
        ...(revoked ? { authenticatedFor: null } : {}),
      });
      this.tryAutoAuthenticate();
    } catch (error) {
      // A refresh that fails no longer proves the rental is still there, so the
      // session goes with it; the error below is the message, the refusal is the
      // consequence. A failed quote keeps the figure the renter last saw rather
      // than clearing it: the price on an unusable panel is a number the contract
      // really did return, and the send button is disabled either way.
      const revoked = this.dropSessionIfRentalChanged(null);
      this.clearAutoAuthState();
      this.fail(this.describe(error));
      this.emitPatch({ chainReady: false, authError: null });
      if (revoked) this.emitPatch({ authenticatedFor: null });
    } finally {
      this.reloading = false;
      finishReload();
    }
  }

  /**
   * Switches the plan the rent button acts on.
   *
   * The quote is re-read rather than recomputed from the plan that was already
   * loaded: availability — the other half of what the rent button depends on —
   * is chain state, and it may have moved since the last read even though the
   * plan's own price did not.
   */
  async selectPlan(planId: number): Promise<void> {
    const plans = this.state.plans;
    if (!plans.some((plan) => plan.planId === planId)) {
      throw new AppError(`Plan ${planId} is not offered by the contract.`);
    }
    this.emitPatch({ busy: 'Reading chain…' });
    try {
      const quote = await this.requireReader().quoteRent(this.requireConfig().nodeId, planId);
      this.emitPatch({ selectedPlanId: planId, quote, busy: null, error: null });
    } catch (error) {
      this.fail(this.describe(error));
    }
  }

  /**
   * Reads `GET /node`, or `null` when the Agent does not answer with one.
   *
   * The status is named in the message rather than swallowed: "the node is
   * unavailable" sends the operator to the Agent, while "the reading cannot be
   * decoded" sends them to the artifact, and one failure string for both would
   * point at the wrong half.
   */
  private async callNode(): Promise<AgentNode | null> {
    try {
      const response = await fetch(`${this.origin}/node`);
      if (!response.ok) {
        throw new AgentError(`Node unavailable: GET /node answered HTTP ${response.status}`, response.status);
      }
      return parseNode(await response.json());
    } catch (error) {
      // An abort is not this: the caller is already tearing the read down, and a
      // converted message would name a node that was never unreachable.
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return null;
    }
  }

  /**
   * Finds the rental that matters right now.
   *
   * A deep link (`?rentalId=7`) names it explicitly. Without one, the node's
   * active rental is the only candidate — a fresh `rent` has no id to name yet,
   * and the node's active slot is where the contract put it.
   *
   * A link naming a rental the contract has already finished is different: that
   * rental is history, it holds no place on the node, and the contract's
   * `activeRentalForNode` will not report it. Following the link anyway leaves the
   * page showing a settled rental with the node free underneath it and no button
   * that leads anywhere, so the node's live slot answers instead. A link to a
   * rental still in play is followed, because then the two readings agree.
   */
  private async resolveCurrentRental(reader: RentalReader): Promise<ChainRental> {
    const config = this.requireConfig();
    const active = await reader.getActiveRentalForNode(config.nodeId);
    const deepLinked = this.deepLinkedRentalId();
    if (deepLinked !== null) {
      const named = await reader.getRental(deepLinked);
      // The linked rental outlived the node's slot only when the contract has
      // finished it; a live one is the same rental `getActiveRentalForNode`
      // reports, so the link is not thrown away by accident.
      if (!isTerminal(named)) return named;
    }
    if (!isNone(active)) {
      return active;
    }
    // Node is unoccupied. If the page was tracking an active or reserved rental that
    // transitioned to terminal onchain (e.g. settled by another actor), resolve to it.
    const currentRental = this.state.rental;
    if (currentRental && !isNone(currentRental) && !isTerminal(currentRental)) {
      const named = await reader.getRental(currentRental.rentalId);
      if (isTerminal(named) && named.nodeId === config.nodeId) {
        return named;
      }
    }
    return active;
  }

  private deepLinkedRentalId(): bigint | null {
    const match = /(?:^|[?&])rentalId=(\d+)/.exec(this.location.search);
    return match ? BigInt(match[1]!) : null;
  }

  async refreshHealth(): Promise<void> {
    try {
      const [health, gpu] = await Promise.all([
        // `fetchHealth` treats every non-2xx, including 503, as degraded. Reading
        // the body alone would accept a 503 whose JSON still says `ok`.
        fetchHealth(this.origin),
        // The GPU line carries its own fallback, because it used to be able to
        // reject across the `Promise.all`: an HTML 503 makes `response.json()`
        // throw, and that one rejection discarded a perfectly good `/health`
        // answer and reported the whole Agent as degraded. `fetchHealth` stays the
        // sole judge of the health slot; this slot only reports a GPU.
        fetch(`${this.origin}/gpu/status`)
          .then(async (response) => parseGpu(response.ok ? await response.json() : {}))
          .catch(() => ({ present: false })),
      ]);
      this.emitPatch({ health, gpu });
    } catch (error) {
      // A failed health read is a degraded state in its own right: the renter
      // must not see a healthy node panel that simply never answered.
      this.emitPatch({
        health: {
          status: 'degraded',
          checks: [{ name: 'agent', status: 'error', detail: this.describe(error) }],
        },
        gpu: { present: false },
      });
    }
  }

  /** Connects the wallet, forces chain 46630, and installs revocation hooks. */
  async connect(): Promise<void> {
    // The wallet may take a moment to show/resolve its approval popup. Without
    // an immediate state change the click looked dead while the provider was
    // waiting for the renter, especially in browsers that open the wallet UI
    // in a separate window.
    this.emitPatch({ busy: 'Connecting wallet…', error: null });
    try {
      const provider = detectProvider();
      const wallet = await connectWallet(provider);
      this.unsubscribe?.();
      // The listeners go in last, so a wallet event firing during the chain
      // switch cannot be handled by a controller still mid-connect.
      this.unsubscribe = onWalletChanged(provider, {
        onAccounts: (accounts) => {
          if (accounts.length === 0) {
            this.disconnect();
            return;
          }
          // A new account is a new identity: the token belongs to the old one,
          // and the stream riding it is answering a request that identity is no
          // longer entitled to. `dropSession` is what does both.
          this.dropSession();
          this.clearAutoAuthState();
          this.identityVersion++;
          this.reconcileGeneration++;
          this.activeReconciliation = null;
          this.emitPatch({
            wallet: { ...this.state.wallet!, account: accounts[0]! },
            account: accounts[0]!,
            authenticatedFor: null,
            authError: null,
            payment: null,
            gasBalance: null,
            chainReady: false,
          });
          void this.reloadChain();
        },
        onChain: (chainId) => {
          const parsed = Number.parseInt(chainId, 16);
          this.identityVersion++;
          this.reconcileGeneration++;
          this.activeReconciliation = null;
          this.dropSession();
          this.clearAutoAuthState();
          if (parsed !== CHAIN_ID) {
            this.dropSession();
            this.emitPatch({
              wallet: null,
              account: null,
              authenticatedFor: null,
              authError: null,
              // The renter's USDG balance and allowance belong to the account
              // that was connected, so they go with it: leaving them would show
              // one wallet's holdings against another's address.
              payment: null,
              gasBalance: null,
              chainReady: false,
              error: `Wallet switched to chain ${parsed}. Chain ${CHAIN_ID} is required.`,
            });
          } else {
            this.emitPatch({ authenticatedFor: null, authError: null, chainReady: false,
              wallet: this.state.wallet ? { ...this.state.wallet, chainId: parsed } : null });
            void this.reloadChain();
          }
        },
        onDisconnect: () => this.disconnect(),
      });

      this.emitPatch({ wallet, account: wallet.account, provider, error: null, authError: null });
      try {
        // Re-read the chain the wallet *is* on: `wallet` captured the chainId
        // before the switch, so keeping it would leave the page asserting chain 1
        // while the wallet sits on 46630 — a banner that never clears and a Rent
        // button that stays disabled for the rest of the session.
        await ensureChain(provider);
        this.emitPatch({ wallet: { ...wallet, chainId: await readChainId(provider) }, account: wallet.account });
      } catch (error) {
        // The account connected, but not on chain 46630, and the switch did not
        // land. Keeping it connected would show a wallet the rental cannot use
        // and would hold a session against the wrong chain, so it is dropped.
        this.disconnect();
        throw error;
      }
      await this.reloadChain();
      this.emitPatch({ busy: null });
    } catch (error) {
      this.guardSession(error);
      this.fail(this.describe(error));
    }
  }

  disconnect(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dropSession();
    this.clearAutoAuthState();
    this.identityVersion++;
    this.reconcileGeneration++;
    this.activeReconciliation = null;
    this.emitPatch({ wallet: null, provider: null, account: null, authenticatedFor: null, authError: null, payment: null, gasBalance: null });
  }

  /** Retries startup as well as current reads; usable when Agent was initially offline. */
  async retry(): Promise<void> {
    if (!this.state.config) await this.reloadConfig();
    await Promise.all([this.reloadChain(), this.refreshHealth()]);
  }

  reportFailure(error: unknown): void { this.fail(this.describe(error)); }
  dismissError(): void { this.emitPatch({ error: null }); }

  async approve(): Promise<void> {
    if (!this.claimSend()) return;
    try {
      const quote = this.state.quote;
      if (!quote) throw new AppError('Choose an available plan first.');
      await approveRental(this.requireProvider(), this.requireReader().client, quote, this.requireAccount(),
        (busy) => this.emitPatch({ busy, error: null }));
      await this.reloadChain();
      this.emitPatch({ notice: 'Approval confirmed. USDG has not been spent yet. Reserve the node next.', busy: null });
    } catch (error) { this.fail(this.describe(error)); }
    finally { this.sending = false; }
  }

  /**
   * Sends `rent` for the selected plan, then re-reads the rental.
   *
   * The price in the send is the one just read from the plan, so what the renter
   * approved is what the contract demands. There is no window for a price the
   * page cached earlier to be wrong by the time it is spent.
   */
  async rent(): Promise<void> {
    try {
      // One send at a time: two clicks before the first receipt arrives would
      // otherwise escrow twice and leave the second rental stranded.
      if (!this.claimSend()) return;
      try {
        const config = this.requireConfig();
        const provider = this.requireProvider();
        const reader = this.requireReader();
        const account = this.requireAccount();

        const planId = this.state.selectedPlanId ?? pickPlanId(this.state.plans, null);
        // A catalog with no active plan cannot be rented from, and the send is
        // refused with that reason rather than aimed at a plan the manager
        // would reject.
        if (planId === null) {
          throw new AppError('The contract offers no rental plan right now.');
        }

        // Re-read rather than reuse: the node may have been taken between the page
        // loading and this click, and the contract's own price is the only one it
        // accepts. Everything the wallet is shown comes from this fresh quote.
        const quote = await reader.quoteRent(config.nodeId, planId);
        if (!quote.available) {
          throw new AppError('This node is not available for rent right now.');
        }

        this.emitPatch({ busy: 'Confirm the rental transaction in your wallet…', error: null });
        // Two signatures this time: the USDG approval the manager needs before it
        // can pull the escrow, and the rental itself. The account is the token's
        // caller, so its balance and allowance can be checked before either.
        const outcome = await rent(provider, reader.client, quote, account, undefined, undefined, {
          allowApproval: false, onProgress: (busy) => this.emitPatch({ busy }),
        });
        await this.reloadChain();
        this.emitPatch({ busy: null, notice: `Rent confirmed · ${outcome.hash.slice(0, 10)}… · USDG is held in escrow.` });
      } finally {
        this.sending = false;
      }
    } catch (error) {
      this.guardSession(error);
      this.fail(this.describe(error));
    }
  }

  /** Cancels a reservation that missed its start deadline. */
  async cancel(): Promise<void> {
    if (this.isReconciling()) return;
    try {
      if (!this.claimSend()) return;
      let txHash: string | null = null;
      let targetRentalId: bigint | null = null;
      try {
        const rental = this.state.rental;
        if (!rental) throw new AppError('There is no rental to cancel.');
        targetRentalId = rental.rentalId;
        const reader = this.requireReader();
        const provider = this.requireProvider();

        const fresh = await reader.getRental(rental.rentalId);
        if (fresh.nodeId !== this.requireConfig().nodeId || fresh.status !== 'RESERVED') {
          throw new AppError('The reservation changed. Refresh before requesting a refund.');
        }
        this.emitPatch({ busy: 'Confirm the cancellation in your wallet…', error: null, authError: null });
        txHash = await sendCancel(provider, reader.client, rental.rentalId);
      } finally {
        this.sending = false;
      }

      if (txHash && targetRentalId !== null) {
        await this.reconcileTerminalState(targetRentalId, 'CANCELLED', txHash);
      }
    } catch (error) {
      this.guardSession(error);
      this.fail(this.describe(error));
    }
  }

  /** Settles a rental that has passed its expiry. */
  async settle(): Promise<void> {
    if (this.isReconciling()) return;
    try {
      if (!this.claimSend()) return;
      let txHash: string | null = null;
      let targetRentalId: bigint | null = null;
      try {
        const rental = this.state.rental;
        if (!rental) throw new AppError('There is no rental to settle.');
        targetRentalId = rental.rentalId;
        const reader = this.requireReader();
        const provider = this.requireProvider();

        const fresh = await reader.getRental(rental.rentalId);
        if (fresh.nodeId !== this.requireConfig().nodeId || fresh.status !== 'ACTIVE') {
          throw new AppError('The rental changed. Refresh before settlement.');
        }
        this.emitPatch({ busy: 'Confirm the settlement in your wallet…', error: null, authError: null });
        txHash = await sendSettle(provider, reader.client, rental.rentalId);
      } finally {
        this.sending = false;
      }

      if (txHash && targetRentalId !== null) {
        await this.reconcileTerminalState(targetRentalId, 'COMPLETED', txHash);
      }
    } catch (error) {
      this.guardSession(error);
      this.fail(this.describe(error));
    }
  }

  /**
   * Bounded reconciliation loop that freshly rereads authoritative contract state
   * after a successful mined settlement or cancellation receipt.
   */
  private async reconcileTerminalState(
    targetRentalId: bigint,
    expectedStatus: 'COMPLETED' | 'CANCELLED',
    txHash: string,
  ): Promise<boolean> {
    const generation = ++this.reconcileGeneration;
    this.activeReconciliation = { rentalId: targetRentalId, generation };
    const identity = this.identityVersion;
    const shortHash = txHash.slice(0, 10);
    const actionLabel = expectedStatus === 'COMPLETED' ? 'Settlement' : 'Refund';

    this.emitPatch({
      busy: `${actionLabel} confirmed · ${shortHash}… · Reconciling chain state…`,
      error: null,
      authError: null,
    });

    const maxAttempts = this.reconcileMaxAttempts;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await this.sleep(this.reconcileDelayMs);
      }
      if (
        this.identityVersion !== identity ||
        this.reconcileGeneration !== generation ||
        this.activeReconciliation?.generation !== generation
      ) {
        return false;
      }

      try {
        const reader = this.requireReader();
        const config = this.requireConfig();
        const readGen = ++this.chainReadGeneration;

        const [freshRental, activeRental, listing] = await Promise.all([
          reader.getRental(targetRentalId),
          reader.getActiveRentalForNode(config.nodeId),
          reader.getListing(config.nodeId),
        ]);

        if (
          this.identityVersion !== identity ||
          this.reconcileGeneration !== generation ||
          this.activeReconciliation?.generation !== generation
        ) {
          return false;
        }

        const isUnoccupied = isNone(activeRental);
        const isTargetTerminal = freshRental.status === expectedStatus;
        const isListingConsistent = listing.nodeId === config.nodeId && listing.active === true;

        if (isTargetTerminal && isUnoccupied && isListingConsistent) {
          const [plans, node, payment, gasBalance] = await Promise.all([
            reader.listPlans(),
            this.callNode(),
            this.state.account && config.paymentToken
              ? readPaymentToken(
                  reader.client,
                  this.state.account,
                  config.paymentToken,
                  config.rentalManagerAddress,
                ).catch(() => null)
              : Promise.resolve(null),
            this.state.account
              ? reader.client.client.getBalance({ address: this.state.account as `0x${string}` }).catch(() => null)
              : Promise.resolve(null),
          ]);

          const selectedPlanId = pickPlanId(plans, this.state.selectedPlanId);
          const quote = selectedPlanId === null
            ? null
            : await reader.quoteRent(config.nodeId, selectedPlanId);

          if (
            this.identityVersion !== identity ||
            this.reconcileGeneration !== generation ||
            this.activeReconciliation?.generation !== generation ||
            readGen < this.lastAppliedChainGeneration
          ) {
            if (
              this.identityVersion === identity &&
              this.reconcileGeneration === generation &&
              this.activeReconciliation?.generation === generation
            ) {
              this.activeReconciliation = null;
              this.emitPatch({ busy: null });
            }
            return false;
          }

          this.lastAppliedChainGeneration = readGen;
          this.activeReconciliation = null;
          this.currentRentalId = freshRental.rentalId;
          this.dropSession();
          this.clearAutoAuthState();

          const notice = expectedStatus === 'COMPLETED'
            ? `Settlement confirmed · ${shortHash}… · 100% of USDG paid to the frozen provider.`
            : `Refund confirmed · ${shortHash}… · 100% of USDG returned to the renter.`;

          this.emitPatch({
            rental: freshRental,
            quote,
            plans,
            selectedPlanId,
            node,
            payment: payment ?? this.state.payment,
            gasBalance: gasBalance ?? this.state.gasBalance,
            authenticatedFor: null,
            authError: null,
            busy: null,
            error: null,
            notice,
            chainReady: true,
          });
          return true;
        }
      } catch {
        // Read error during attempt; continue loop
      }
    }

    if (
      this.identityVersion === identity &&
      this.reconcileGeneration === generation
    ) {
      this.activeReconciliation = null;
      const timeoutNotice = `${actionLabel} confirmed. Waiting for updated chain state…`;
      this.emitPatch({
        busy: null,
        notice: timeoutNotice,
        error: null,
        authError: null,
      });
    }
    return false;
  }

  /**
   * Logs in against the current rental.
   *
   * The Agent refuses a challenge unless the rental is ACTIVE right now, so the
   * button only appears once `isAccessible` says so. That check is the UI's; the
   * Agent's is the one that decides.
   */
  async login(): Promise<void> {
    if (this.authPending) return;
    this.authPending = true;
    const identity = this.identityVersion;
    try {
      const rental = this.state.rental;
      if (!rental) throw new AppError('There is no rental to sign in against.');
      const held = this.sessionStore.session;
      // A dead session is not a head start: re-signing over a token that already
      // timed out spends a wallet prompt to reach the same 401 the old one gets.
      // With no session at all there is nothing expired, so this stays quiet and
      // the sign-in proceeds the way it always did.
      if (held !== null && this.sessionStore.isExpired()) {
        this.dropSession();
        this.emitPatch({ authenticatedFor: null });
        throw new AppError('Your session has expired. Sign in again.');
      }
      const account = this.requireAccount();
      const provider = this.requireProvider();
      if (!isAccessible(rental, Date.now())) {
        throw new AppError('The rental is not active right now. Wait for the provider to start it.');
      }

      // `eth_signTypedData_v4` is chain-scoped: a signature made against the
      // domain of one chain is meaningless to an Agent accepting it for another.
      await ensureChain(provider);

      this.emitPatch({ busy: 'Waiting for your wallet signature…', error: null, authError: null });
      const session = await authenticate(this.origin, provider, account, rental.rentalId);
      if (
        identity !== this.identityVersion
        || this.state.rental?.rentalId !== rental.rentalId
        || !isAccessible(this.state.rental, Date.now())
        || session.rentalId !== rental.rentalId
        || session.expiresAt > Number(rental.expiresAt)
      ) {
        this.dropSession();
        throw new AppError('Rental or wallet changed during authentication.');
      }
      this.sessionStore.set(session);
      this.emitPatch({ authenticatedFor: session.rentalId, busy: null, error: null, authError: null });
    } catch (error) {
      const message = this.describe(error);
      this.guardSession(error);
      this.emitPatch({ authError: message, busy: null, error: message });
    } finally {
      this.authPending = false;
    }
  }

  /** Streams inference, writing each assembled frame into the transcript. */
  async runInference(prompt: string): Promise<void> {
    if (this.state.streaming) return;
    const rental = this.state.rental;
    if (!rental) throw new AppError('There is no rental to run against.');
    if (!isAccessible(rental, Date.now())) throw new AppError('Rental access has expired or is not ACTIVE.');
    // Expiry is checked here rather than only in the Agent's 401, because a token
    // past its expiry is already refused: sending it turns a known-bad session
    // into a failed turn and a stack of frames the other side drops. Checking it
    // against `Date.now()` at the send keeps an idle tab from streaming on a
    // session that lapsed while it sat there. It is placed after the rental match
    // so the message names the actual problem: a session for a *different* rental
    // is a sign-in away, not a sign-in that timed out.
    if (!this.sessionStore.matchesRental(rental.rentalId)) {
      throw new AppError('Sign in against this rental first.');
    }
    if (this.sessionStore.isExpired()) {
      this.dropSession();
      this.emitPatch({ authenticatedFor: null });
      throw new AppError('Your session has expired. Sign in again.');
    }
    const token = this.sessionStore.token;
    if (!token) throw new AppError('Your session has expired. Sign in again.');
    if (prompt.trim().length === 0) throw new AppError('Enter a prompt first.');

    this.inferenceController?.abort();
    const generation = new AbortController();
    this.inferenceController = generation;
    this.emitPatch({ streaming: true, inferenceOutput: '', error: null });

    this.appendTurn('user', prompt);
    const answerTurn = this.appendTurn('assistant', '');
    if (answerTurn === null) {
      // The transcript refused the turn. Reporting it beats letting the stream
      // write into a turn that was never created.
      this.fail('The transcript could not be updated. Reload the page and try again.');
      this.emitPatch({ streaming: false });
      return;
    }

    try {
      for await (const text of streamInference(
        this.origin,
        token,
        { prompt },
        generation.signal,
      )) {
        this.updateTurn(answerTurn, text);
        // ChatView updates this text in place. Replacing the entire page for
        // every 35ms delta detaches Cancel under the pointer and loses typing,
        // focus and scroll. Emit again only for actual control/state changes.
        this.state = { ...this.state, inferenceOutput: text };
      }
      this.draftPrompt = '';
    } catch (error) {
      // A 401/409 from the agent means this token is dead; forgetting it here
      // is the difference between one failed message and an endless retry.
      if (this.guardSession(error)) {
        this.failTurn(answerTurn, 'Your session was rejected. Sign in again.');
        return;
      }
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const message = this.describe(error);
      this.failTurn(answerTurn, message);
      this.fail(message);
    } finally {
      if (this.inferenceController === generation) {
        this.inferenceController = null;
        this.emitPatch({ streaming: false });
      }
    }
  }

  /** Stops a running stream, which is the renter's action, not a failure. */
  stopInference(): void {
    this.inferenceController?.abort();
    // Keep the generation slot until the aborted fetch has actually unwound.
    // Otherwise a second click can replace the controller before finally runs.
  }

  /** Advances the countdown each second; a panel must never read stale times. */
  private tick(): void {
    const rental = this.state.rental;
    if (!rental) return;
    if (this.sessionStore.session && (!isAccessible(rental, Date.now()) || this.sessionStore.isExpired())) {
      this.dropSession();
      this.state = { ...this.state, authenticatedFor: null, streaming: false };
    }
    if (rental.status === 'ACTIVE' && !isAccessible(rental, Date.now())) {
      this.clearAutoAuthState();
      this.state = { ...this.state, authError: null };
    }
    if (isTerminal(rental)) {
      this.clearAutoAuthState();
      this.state = { ...this.state, authError: null };
    }
    this.tryAutoAuthenticate();
    if (rental.status !== 'RESERVED' && !isActiveWindow(rental)) return;
    // Recomputed from the chain-read expiry against *now*, never against when
    // the page loaded, so an idle tab cannot show a window that has closed. The
    // stage and every deadline on screen are derived from this same rental, so
    // re-emitting is enough for the page to show the new numbers.
    this.state = { ...this.state };
    this.emit();
  }

  /** Exposes the lifecycle stage the page uses to pick its buttons. */
  stage(): ReturnType<typeof lifecycleStage> {
    const rental = this.state.rental;
    const account = this.state.account;
    if (!rental || !account) return 'none';
    return lifecycleStage(rental, account, Date.now());
  }

  /**
   * The current session's identity, or null when there is none.
   *
   * An expired session is reported as null, on purpose: it was reported as
   * present, so the panel showed "valid until 14:02" after 14:02 and offered a
   * Send button the send guard then refused. The two now agree — an expired token
   * is a token the page does not have — so the panel's "Not signed in" is the
   * same fact the controller acts on.
   *
   * `isExpired()` returns true when there is no session at all, which is also
   * null by the first branch of the same test, so one call covers both.
   */
  sessionInfo(): { rentalId: bigint; expiresAt: number } | null {
    if (this.sessionStore.isExpired()) return null;
    const session = this.sessionStore.session;
    if (session === null) return null;
    return { rentalId: session.rentalId, expiresAt: session.expiresAt };
  }

  /** The page hands its transcript container over on each render. */
  bindChat(chat: ChatView): void {
    this.chat = chat;
    for (const turn of this.turns) chat.add(turn.id, turn.kind, turn.text, turn.failed);
  }

  /**
   * Appends a turn and returns its id, or `null` when the transcript cannot
   * take it.
   *
   * Returning `null` rather than throwing is the point: a chat view that has
   * lost its container used to throw out of `add`, and the caller then crashed
   * mid-stream with the answer half-shown and no error of its own. A refused
   * append is reported; it does not take the page down.
   */
  private appendTurn(kind: Turn['kind'], text: string): number | null {
    const id = this.turns.length + 1;
    this.turns.push({ id, kind, text, failed: false });
    try {
      this.chat?.add(id, kind, text);
    } catch (error) {
      this.turns.pop();
      this.fail(error instanceof Error ? error.message : String(error));
      return null;
    }
    return id;
  }

  private updateTurn(id: number, text: string): void {
    const turn = this.turns.find((candidate) => candidate.id === id);
    if (!turn) return;
    turn.text = text;
    // The node is updated in place. Rebuilding the whole transcript here is what
    // used to lose a delta: the frame was appended to a node that the previous
    // rebuild had already detached from the document. A missing node is not an
    // error either — the text is already held on the turn, and the next render
    // rebuilds the transcript from that list.
    try {
      this.chat?.update(id, text);
    } catch {
      // The DOM node is gone. The turn text above is the record that survives.
    }
  }

  private failTurn(id: number, message: string): void {
    const turn = this.turns.find((candidate) => candidate.id === id);
    if (!turn) return;
    turn.failed = true;
    turn.text = turn.text.length > 0 ? `${turn.text}\n\n${message}` : message;
    this.chat?.remove(id);
    this.chat?.add(id, turn.kind, turn.text, true);
  }
}

class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppError';
  }
}

/** True while the rental is inside its billable window. */
function isActiveWindow(rental: ChainRental): boolean {
  return rental.status === 'ACTIVE' && rental.expiresAt > 0n;
}

export { AppError, statusMapper };
