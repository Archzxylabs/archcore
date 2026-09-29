/** Safe DOM renderer for the compute-leasing console. Remote data is text, never HTML. */
import { CHAIN_ID } from './config';
import { formatAtomic, USDG_DECIMALS_EXPECTED } from './chainPure';
import { isNone, canBeStarted, isAccessible, type ChainRental } from './rentalState';
import type { RenterApp } from './app';

export interface Turn { id: number; kind: 'user' | 'assistant'; text: string; failed: boolean }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '', id = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  if (id) node.id = id;
  return node;
}
function action(app: RenterApp, label: string, run: () => void | Promise<void>, disabled = false,
  reason = '', secondary = false, id = ''): HTMLButtonElement {
  const node = el('button', label, secondary ? 'secondary' : '', id);
  node.type = 'button'; node.disabled = disabled; node.title = disabled ? reason : '';
  node.addEventListener('click', () => {
    try { Promise.resolve(run()).catch((error: unknown) => app.reportFailure(error)); }
    catch (error) { app.reportFailure(error); }
  });
  return node;
}
function panel(title: string, subtitle = '', className = ''): HTMLElement {
  const box = el('section', '', `card ${className}`);
  box.append(el('h2', title));
  if (subtitle) box.append(el('p', subtitle, 'section-subtitle'));
  return box;
}
function stat(label: string, value: string, className = ''): HTMLElement {
  const box = el('div', '', `stat ${className}`);
  box.append(el('span', label, 'stat-label'), el('strong', value, 'stat-value'));
  return box;
}
function shorten(value: string): string { return `${value.slice(0, 6)}…${value.slice(-4)}`; }
export function formatToken(amount: bigint, decimals: number, symbol = ''): string { return formatAtomic(amount, decimals, symbol); }
export function durationLabel(seconds: bigint): string {
  if (seconds === 86400n) return '24 hours';
  if (seconds >= 86400n) return `${seconds / 86400n} days`;
  if (seconds >= 3600n) return `${seconds / 3600n} hours`;
  return `${seconds / 60n} minutes`;
}
export function hourlyRate(price: bigint, seconds: bigint, decimals = 6): string {
  return seconds > 0n ? `${formatAtomic(price * 3600n / seconds, decimals)} USDG / hour` : '—';
}
function countdown(deadline: bigint): string {
  const remaining = Math.max(0, Number(deadline) - Math.floor(Date.now() / 1000));
  const days = Math.floor(remaining / 86400);
  return `${days ? `${days}d ` : ''}${String(Math.floor(remaining / 3600) % 24).padStart(2, '0')}:${String(Math.floor(remaining / 60) % 60).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
}
function header(app: RenterApp): HTMLElement {
  const head = el('header', '', 'app-header');
  const brand = el('div', '', 'brand');
  brand.append(el('span', 'A', 'brand-mark'), el('span', 'ARCHcore', 'wordmark'), el('span', 'COMPUTE LEASING', 'brand-caption'));
  const controls = el('div', '', 'header-controls');
  controls.append(el('span', 'Robinhood Testnet · 46630', 'network-pill'));
  const wallet = app.state.wallet; const connecting = app.state.busy === 'Connecting wallet…';
  if (wallet) controls.append(el('span', shorten(wallet.account), 'wallet-address'));
  controls.append(action(app, wallet ? 'Disconnect' : connecting ? 'Connecting…' : 'Connect wallet',
    () => wallet ? app.disconnect() : app.connect(), connecting, 'Waiting for your wallet.', Boolean(wallet), 'connect-wallet'));
  head.append(brand, controls); return head;
}
function assetPanel(app: RenterApp): HTMLElement {
  const box = panel('Compute Asset / Node 01', 'One provider identity. Exclusive, time-bounded usage rights.', 'asset-panel');
  const available = app.state.chainReady && app.state.quote?.available === true;
  const occupied = app.state.rental && ['RESERVED', 'ACTIVE'].includes(app.state.rental.status);
  const status = !app.state.chainReady ? 'UNVERIFIED' : occupied ? 'OCCUPIED' : available ? 'AVAILABLE' : 'UNAVAILABLE';
  box.append(el('span', status, `state-pill ${available ? 'ok' : ''}`));
  const identity = el('div', '', 'asset-identity');
  const description = el('div', '', 'asset-description');
  description.append(el('h3', 'Onchain compute identity'), el('p', 'Soulbound ComputeAsset · Arbitrum Stylus', 'muted'));
  identity.append(el('div', '01', 'asset-number'), description); box.append(identity);
  const stats = el('div', '', 'asset-stats');
  stats.append(stat('Payment', 'USDG escrow'), stat('Start grace', '120 seconds'), stat('Capacity', '1 rental / 1 inference'));
  box.append(stats);
  const details = el('div', '', 'asset-details');
  details.append(el('span', 'Provider', 'muted'), el('code', app.state.node?.provider ?? 'Not verified', 'address'));
  if (app.state.config) details.append(el('span', 'RentalManager', 'muted'), el('code', app.state.config.rentalManagerAddress, 'address'));
  box.append(details, el('div', 'EXPLICIT DEMO MODE · Model computation is simulated. Wallet transactions, USDG escrow and access enforcement are real.', 'demo-note'));
  return box;
}
function plansPanel(app: RenterApp): HTMLElement {
  const box = panel('Choose your lease', 'Immutable plans read from the contract. Prices are total USDG, not native ETH.', 'plans-panel');
  if (!app.state.plans.length) { box.append(el('p', 'Waiting for verified onchain plans. No price is guessed.', 'muted')); return box; }
  const grid = el('div', '', 'plan-grid');
  for (const plan of app.state.plans.filter((item) => !item.demoOnly)) {
    const selected = app.state.selectedPlanId === plan.planId;
    const control = action(app, '', () => app.selectPlan(plan.planId), !plan.active || Boolean(app.state.busy),
      !plan.active ? 'This plan is inactive.' : 'Wait for the current operation.', true, `plan-${plan.planId}`);
    control.className = `plan-card${selected ? ' selected' : ''}`;
    control.setAttribute?.('aria-pressed', String(selected));
    control.append(el('span', durationLabel(plan.durationSeconds), 'plan-duration'),
      el('strong', formatAtomic(plan.priceAtomic, 6), 'plan-price'), el('span', 'USDG total', 'muted'),
      el('span', hourlyRate(plan.priceAtomic, plan.durationSeconds), 'plan-rate'),
      el('span', selected ? 'SELECTED' : `PLAN ${plan.planId}`, 'plan-indicator'));
    grid.append(control);
  }
  box.append(grid);
  for (const plan of app.state.plans.filter((item) => item.demoOnly)) {
    const selected = app.state.selectedPlanId === plan.planId;
    const control = action(app, '', () => app.selectPlan(plan.planId), !plan.active || Boolean(app.state.busy),
      'Wait for the current operation.', true, `plan-${plan.planId}`);
    control.className = `demo-plan${selected ? ' selected' : ''}`; control.setAttribute?.('aria-pressed', String(selected));
    control.append(el('span', 'TESTNET DEMO', 'demo-label'), el('strong', '5 MINUTES'),
      el('span', `${formatAtomic(plan.priceAtomic, 6)} USDG · compressed lifecycle`, 'muted'),
      el('span', selected ? 'SELECTED' : 'TRY DEMO', 'plan-indicator'));
    box.append(control);
  }
  return box;
}
function checkout(app: RenterApp): HTMLElement {
  const box = panel('Your checkout', 'USDG for the lease. Testnet ETH for gas only.', 'checkout-panel');
  const quote = app.state.quote; const payment = app.state.payment; const wallet = app.state.wallet;
  box.append(stat('Selected duration', quote ? durationLabel(quote.durationSeconds) : 'Select a plan'),
    stat('Escrow amount', quote ? formatAtomic(quote.priceAtomic, 6, 'USDG') : '—', 'checkout-price'));
  const accountStats = el('div', '', 'checkout-stats');
  accountStats.append(stat('USDG balance', payment ? formatAtomic(payment.balance, payment.decimals, 'USDG') : 'Connect to verify'),
    stat('Manager allowance', payment ? formatAtomic(payment.allowance, payment.decimals, 'USDG') : 'Not verified'),
    stat('ETH for gas', app.state.gasBalance === null ? 'Not verified' : `${formatAtomic(app.state.gasBalance, 18)} ETH`));
  box.append(accountStats);
  const approved = payment && quote && payment.allowance >= quote.priceAtomic;
  const canPay = payment && quote && payment.balance >= quote.priceAtomic;
  // Availability comes from the fresh contract quote. A terminal rental is
  // retained only as lifecycle history, and it may belong to the previously
  // connected wallet; that historical ownership must not block a new renter.
  const rentalBlocksNode = app.state.rental !== null
    && ['RESERVED', 'ACTIVE'].includes(app.state.rental.status);
  const reason = !wallet ? 'Connect your renter wallet to verify balance and allowance.'
    : wallet.chainId !== CHAIN_ID ? 'Switch your wallet to Robinhood Chain Testnet.'
    : !app.state.chainReady ? 'Fresh chain reads are unavailable. Refresh before paying.'
    : rentalBlocksNode || !quote?.available ? 'Node 1 is occupied or unavailable.'
    : !payment ? 'USDG metadata and balance have not been verified.'
    : payment.decimals !== USDG_DECIMALS_EXPECTED ? 'USDG decimals do not match the frozen contract.'
    : !canPay ? 'Insufficient USDG balance for this plan.'
    : app.state.gasBalance === 0n ? 'Your wallet needs testnet ETH for transaction gas.' : '';
  const blocked = Boolean(reason) || Boolean(app.state.busy);
  if (approved) {
    box.append(el('p', 'Allowance verified · no approval transaction needed.', 'status ok'),
      action(app, 'Rent', () => app.rent(), blocked, reason || 'Transaction in progress.', false, 'rent-node'));
  } else {
    box.append(action(app, 'Approve USDG', () => app.approve(), blocked, reason || 'Transaction in progress.', false, 'approve-usdg'),
      el('p', '1. Approve exact amount → 2. Rent → 3. Wait for provider start', 'checkout-steps'));
  }
  if (reason) box.append(el('p', reason, 'action-explanation'));
  box.append(el('p', 'Escrow is paid to the frozen provider after ACTIVE expiry. If the provider misses the start deadline, 100% returns to you.', 'fine-print'));
  return box;
}
function lifecycle(app: RenterApp): HTMLElement {
  const box = panel('Rental lifecycle', 'Contract state is authoritative. Timers are display aids.', 'lifecycle-panel');
  const rental = app.state.rental; const active = rental?.status === 'ACTIVE'; const reserved = rental?.status === 'RESERVED';
  const stage = app.stage(); const track = el('ol', '', 'lifecycle-track');
  const labels = ['AVAILABLE', 'RESERVED', 'ACTIVE', rental?.status === 'CANCELLED' ? 'CANCELLED / REFUNDED' : 'COMPLETED'];
  const current = !rental || rental.status === 'NONE' ? 0 : reserved ? 1 : active ? 2 : 3;
  labels.forEach((label, index) => track.append(el('li', label, index === current ? 'current' : index < current ? 'done' : '')));
  box.append(track);
  if (!rental || rental.status === 'NONE') box.append(el('p', 'No current rental. Select a plan to reserve Node 1.', 'muted'));
  else {
    box.append(el('div', `Rental #${rental.rentalId} · Plan ${rental.planId} · ${rental.status}`, 'rental-reference'));
    if (reserved || active) box.append(stat(reserved ? 'Provider start deadline in' : 'Access expires in', countdown(reserved ? rental.startDeadline : rental.expiresAt), 'countdown'));
    if (reserved) box.append(el('p', stage === 'expired' ? 'Provider missed the start deadline. Refund is now permissionless.' : 'Waiting for the Provider Agent to start. There is nothing for the renter to sign yet.', 'muted'));
    if (active) box.append(el('p', stage === 'expired' ? 'Automatic settlement pending. You may settle now as a permissionless fallback.' : 'Time-bounded access is active. Settlement will be submitted automatically after expiry.', 'muted'));
    if (rental.status === 'COMPLETED') box.append(el('p', '100% escrow paid to the frozen provider. Node is released after chain confirmation.', 'status ok'));
    if (rental.status === 'CANCELLED') box.append(el('p', '100% escrow refunded to the renter. Node is released after chain confirmation.', 'status ok'));
    if (stage === 'foreign') box.append(el('p', 'Another renter holds this lease. Inference is unavailable to your wallet.', 'action-explanation'));
    const expired = Math.floor(Date.now() / 1000) >= Number(reserved ? rental.startDeadline : rental.expiresAt);
    const disabled = !app.state.wallet || Boolean(app.state.busy);
    if (reserved && expired) box.append(action(app, 'Claim 100% refund', () => app.cancel(), disabled, 'Connect a wallet; wait for pending transactions.', false, 'refund-rental'));
    if (active && expired) box.append(action(app, 'Settle now', () => app.settle(), disabled, 'Connect a wallet; wait for pending transactions.', false, 'settle-rental'));
  }
  return box;
}
export function inferenceExplanation(
  rental: ChainRental | null,
  nowMs = Date.now(),
  authStatus?: { running?: boolean; error?: string | null },
): string {
  if (!rental || rental.status === 'NONE' || isNone(rental)) {
    return 'Reserve Node 1 and wait for the provider to start the rental.';
  }
  if (rental.status === 'RESERVED') {
    return canBeStarted(rental, nowMs)
      ? 'Waiting for the provider to start this rental. Inference becomes available only after the rental is ACTIVE.'
      : 'The provider missed the start deadline. Inference is unavailable; claim the full USDG refund.';
  }
  if (rental.status === 'ACTIVE') {
    if (!isAccessible(rental, nowMs)) {
      return 'This rental has expired. Inference access is closed. Automatic settlement is pending; you may settle now as a fallback.';
    }
    if (authStatus?.running) {
      return 'Waiting for your wallet signature…';
    }
    if (authStatus?.error) {
      return authStatus.error;
    }
    return 'Confirm access in your wallet.';
  }
  if (rental.status === 'CANCELLED') {
    return 'This rental was cancelled and refunded. Node 1 may be rented again after the authoritative occupancy read clears.';
  }
  if (rental.status === 'COMPLETED') {
    return 'This rental was settled. Node 1 may be rented again after the authoritative occupancy read clears.';
  }
  return 'Reserve Node 1 and wait for the provider to start the rental.';
}

function inferencePanel(app: RenterApp): HTMLElement {
  const box = panel('Private inference workspace', 'Explicit Demo Inference Backend · simulated computation, real access enforcement.', 'inference-panel');
  const session = app.sessionInfo(); const stage = app.stage();
  const rental = app.state.rental;
  const authRunning = app.isAuthRunning();
  const authError = app.state.authError;
  const explanation = inferenceExplanation(rental, Date.now(), { running: authRunning, error: authError });
  const authFailed = !session && Boolean(authError);
  const authDisabled = Boolean(session) || authRunning || stage !== 'active' || Boolean(app.state.busy && !authRunning);
  const authReason = session
    ? 'Session is held only in memory.'
    : authRunning
      ? 'Waiting for your wallet signature…'
      : app.state.busy
        ? 'Wait for the current operation.'
        : stage === 'foreign'
          ? 'Another renter holds this lease. Inference is unavailable to your wallet.'
          : explanation;
  const buttonLabel = session
    ? 'Authenticated'
    : authRunning
      ? 'Waiting for your wallet signature…'
      : authFailed
        ? 'Try authentication again'
        : 'Authenticate rental';
  const toolbar = el('div', '', 'inference-toolbar');
  toolbar.append(el('span', session ? 'SESSION AUTHENTICATED' : 'SESSION LOCKED', `state-pill ${session ? 'ok' : ''}`),
    el('span', '10 requests / lease · 1 concurrent · 30s timeout', 'muted'),
    action(app, buttonLabel, () => app.login(), authDisabled,
      authReason, true, 'authenticate-rental'));
  box.append(toolbar);
  if (!session) box.append(el('p', explanation, 'action-explanation'));
  const transcript = el('div', '', 'chat', 'transcript');
  transcript.setAttribute?.('role', 'log'); transcript.setAttribute?.('aria-label', 'Inference output');
  if (!app.turns.length) transcript.append(el('p', 'Generation output appears here after an authenticated request.', 'empty-output'));
  box.append(transcript);
  const input = el('textarea', '', '', 'prompt');
  input.placeholder = 'Describe a text-generation task…'; input.value = app.draftPrompt; input.rows = 3;
  input.disabled = !session || app.state.streaming;
  const label = el('label', 'Prompt', 'prompt-label'); label.htmlFor = 'prompt';
  input.addEventListener('input', () => { app.draftPrompt = input.value; });
  const row = el('div', '', 'inference-actions');
  row.append(el('span', '8 KiB prompt limit · output bounded to 256 equivalent tokens', 'fine-print'),
    action(app, app.state.streaming ? 'Cancel generation' : 'Generate', () => app.state.streaming ? app.stopInference() : app.runInference(input.value),
      !session && !app.state.streaming, 'Authenticate an ACTIVE rental first.', false, 'generate-inference'));
  box.append(label, input, row); app.bindChat(new ChatView(transcript)); return box;
}
export class ChatView {
  private readonly nodes = new Map<number, HTMLElement>();
  constructor(private readonly container: HTMLElement) {}
  add(id: number, kind: 'user' | 'assistant', text: string, failed = false): void {
    const node = el('div', text, `msg ${kind}${failed ? ' failed' : ''}`);
    try { this.container.append(node); } catch { throw new Error('The transcript could not be updated.'); }
    this.nodes.set(id, node);
  }
  update(id: number, text: string): void { const node = this.nodes.get(id); if (node) node.textContent = text; }
  remove(id: number): void { this.nodes.get(id)?.remove(); this.nodes.delete(id); }
  clear(): void { this.container.replaceChildren(); this.nodes.clear(); }
}
export function render(root: HTMLElement, app: RenterApp): void {
  const focused = document.activeElement as HTMLTextAreaElement | null;
  const focusId = focused?.id;
  const selection = focusId === 'prompt' ? [focused?.selectionStart, focused?.selectionEnd] : null;
  const scroll = document.getElementById?.('transcript')?.scrollTop;
  const page = el('div', '', 'container'); page.append(header(app));
  const intro = el('div', '', 'page-intro'); const copy = el('div', '', 'intro-copy');
  copy.append(el('span', 'REAL WORLD ASSETS / COMPUTE', 'eyebrow'), el('h1', 'Lease compute. Settle onchain.'),
    el('p', 'Exclusive usage rights. USDG escrow. Access that ends when your lease does.', 'subtitle'));
  intro.append(copy, action(app, 'Refresh status', () => app.retry(), Boolean(app.state.busy), 'An operation is in progress.', true, 'refresh-status'));
  page.append(intro);
  const feedback = el('div', '', 'feedback'); feedback.setAttribute?.('aria-live', 'polite');
  if (app.state.busy) feedback.append(el('p', app.state.busy, 'notice pending'));
  if (app.state.notice && !app.state.busy) feedback.append(el('p', app.state.notice, 'notice success'));
  if (app.state.error) {
    const error = el('div', '', 'notice err'); error.setAttribute?.('role', 'alert');
    error.append(el('span', app.state.error), action(app, 'Dismiss', () => app.dismissError(), false, '', true, 'dismiss-error')); feedback.append(error);
  }
  page.append(feedback);
  if (!app.state.config) {
    const empty = panel('Connect to the Provider Agent');
    empty.append(el('p', 'Waiting for the Agent’s configuration. Start the local Agent, then retry. No rental price or state is guessed.', 'muted'),
      action(app, 'Retry connection', () => app.retry(), Boolean(app.state.busy), 'Connection attempt in progress.')); page.append(empty);
  } else {
    const workspace = el('div', '', 'workspace'); const main = el('main', '', 'main-column'); const side = el('aside', '', 'side-column');
    main.append(assetPanel(app), plansPanel(app)); side.append(checkout(app), lifecycle(app));
    workspace.append(main, side); page.append(workspace, inferencePanel(app));
  }
  const footer = el('footer', '', 'app-footer'); const health = app.state.health;
  footer.append(el('span', health?.status === 'ok' ? 'Agent / demo backend ready' : 'Agent readiness unverified or degraded', `status ${health?.status === 'ok' ? 'ok' : ''}`));
  if (health?.status !== 'ok') footer.append(el('span', health?.checks.filter((item) => item.status !== 'ok')
    .map((item) => `${item.name}: ${item.detail ?? item.status}`).join(' · ') ?? '', 'muted'));
  footer.append(el('span', 'LOCAL MODE · OmniRoute verification deferred · No physical GPU claimed', 'fine-print')); page.append(footer);
  root.replaceChildren(page);
  if (focusId) {
    const next = document.getElementById?.(focusId) as HTMLTextAreaElement | null;
    if (next && !next.disabled) { next.focus(); if (selection && selection[0] !== null && selection[0] !== undefined) next.setSelectionRange(selection[0], selection[1] ?? selection[0]); }
  }
  const transcript = document.getElementById?.('transcript'); if (transcript && scroll !== undefined) transcript.scrollTop = scroll;
}
export { CHAIN_ID };
