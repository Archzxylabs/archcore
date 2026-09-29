/**
 * Wallet connection and chain guard.
 *
 * The wallet is reached only through the injected EIP-1193 provider. There is no
 * intermediate server: value-bearing transactions (`rent`) must be signed by
 * the renter, so routing them through a relayer would put the renter's funds in
 * someone else's hands and is therefore not an option.
 *
 * Two rules are enforced here rather than left to the UI:
 *
 * 1. **Chain 46630 only.** A transaction signed for another chain is rejected
 *    by the network at best and lost at worst, so the app asks the wallet to
 *    switch before any send.
 * 2. **Session revocation on any change.** Account, chain, or disconnect means
 *    the bearer token no longer belongs to the person looking at the screen, so
 *    the caller's session is dropped. The UI reflects it, but the trigger is
 *    here, where the change is actually observed.
 */

import { CHAIN_ID, CHAIN_ID_HEX, CHAIN_NAME, CHAIN_NATIVE_CURRENCY } from './config';
import { DEFAULT_EXPLORER_URL, DEFAULT_RPC_URL } from './chainPure';

/** EIP-1193 surface, reduced to what this app calls. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export class WalletError extends Error {
  /** The EIP-1193 code, kept so a caller can tell "chain unknown" from "declined". */
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/** The connected wallet, and the state the UI renders. */
export interface WalletState {
  account: string;
  chainId: number;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function detectProvider(): Eip1193Provider {
  const provider = typeof window !== 'undefined' ? window.ethereum : undefined;
  if (!provider) {
    throw new WalletError('No browser wallet found. Install an EIP-1193 wallet and reload.');
  }
  return provider;
}

async function request(provider: Eip1193Provider, method: string, params?: unknown[]): Promise<unknown> {
  try {
    return await provider.request({ method, ...(params === undefined ? {} : { params }) });
  } catch (error) {
    // EIP-1193 reports user rejection with code 4001; anything else is surfaced
    // verbatim so the wallet's own message reaches the user unaltered.
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (code === 4001) throw new WalletError('You rejected the request in your wallet.', 4001);
      // 4902 means the chain is not in the wallet yet. The code is kept on the
      // error so `ensureChain` can add the chain and retry; the message is the
      // wallet's own, so the renter sees why rather than a stack.
      if (code === 4902) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new WalletError(reason, 4902);
      }
      throw new WalletError('The wallet declined the request.', typeof code === 'number' ? code : undefined);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new WalletError(reason);
  }
}

/** Connects and returns the accounts the user approved. */
export async function connectWallet(provider: Eip1193Provider): Promise<WalletState> {
  const accounts = (await request(provider, 'eth_requestAccounts')) as unknown;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new WalletError('Wallet returned no account. Unlock it and try again.');
  }
  const account = accounts[0];
  if (typeof account !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(account)) {
    throw new WalletError('Wallet returned an account that is not an address.');
  }
  const chainId = await readChainId(provider);
  return { account, chainId };
}

export async function readChainId(provider: Eip1193Provider): Promise<number> {
  const raw = await request(provider, 'eth_chainId');
  const hex = typeof raw === 'string' ? raw : String(raw);
  const value = Number.parseInt(hex, 16);
  if (!Number.isInteger(value)) throw new WalletError('Wallet returned an unreadable chain id.');
  return value;
}

/**
 * Ensures the wallet is on chain 46630, switching or adding the network.
 *
 * Returns the chain id the wallet is actually on, read after the switch and
 * verified against 46630. The caller's cached `chainId` predates the switch, so
 * this is the only value that describes where the wallet ended up.
 *
 * The chain is added first when the wallet reports it as unknown, because
 * `wallet_switchEthereumChain` rejects an unlisted chain with code 4902.
 */
export async function ensureChain(provider: Eip1193Provider): Promise<number> {
  const chainId = await readChainId(provider);
  if (chainId === CHAIN_ID) return chainId;

  try {
    await request(provider, 'wallet_switchEthereumChain', [{ chainId: CHAIN_ID_HEX }]);
  } catch (error) {
    const unlisted = error instanceof WalletError && error.code === 4902;
    if (!unlisted) throw error;

    await request(provider, 'wallet_addEthereumChain', [
      {
        chainId: CHAIN_ID_HEX,
        chainName: CHAIN_NAME,
        nativeCurrency: CHAIN_NATIVE_CURRENCY,
        rpcUrls: [DEFAULT_RPC_URL],
        blockExplorerUrls: [DEFAULT_EXPLORER_URL],
      },
    ]);
    // Adding a chain lists it; it does not switch to it. A wallet that accepted
    // the add and stayed where it was would otherwise pass this guard.
    await request(provider, 'wallet_switchEthereumChain', [{ chainId: CHAIN_ID_HEX }]);
  }

  const after = await readChainId(provider);
  if (after !== CHAIN_ID) {
    throw new WalletError(`Wallet is on chain ${after}; the rental needs chain ${CHAIN_ID}.`);
  }
  return after;
}

/**
 * Subscribes to the wallet events that invalidate a session.
 *
 * The returned function unsubscribes; the caller invokes it when tearing down,
 * so a replaced UI cannot leak listeners that keep firing after the page has
 * moved on to another rental.
 */
export function onWalletChanged(
  provider: Eip1193Provider,
  handlers: {
    onAccounts(accounts: string[]): void;
    onChain(chainId: string): void;
    onDisconnect(): void;
  },
): () => void {
  const accounts = (...args: unknown[]): void => {
    const list = Array.isArray(args[0]) ? (args[0] as string[]) : [];
    handlers.onAccounts(list);
  };
  const chain = (...args: unknown[]): void => {
    const raw = args[0];
    handlers.onChain(typeof raw === 'string' ? raw : '0x0');
  };
  const disconnect = (): void => handlers.onDisconnect();

  provider.on?.('accountsChanged', accounts);
  provider.on?.('chainChanged', chain);
  provider.on?.('disconnect', disconnect);

  return () => {
    provider.removeListener?.('accountsChanged', accounts);
    provider.removeListener?.('chainChanged', chain);
    provider.removeListener?.('disconnect', disconnect);
  };
}

/** Sends a signed transaction and returns its hash once the wallet accepts it. */
export async function sendTransaction(
  provider: Eip1193Provider,
  tx: { to: string; data: string; value: string; from?: string },
): Promise<string> {
  const accounts = await request(provider, 'eth_accounts');
  const from = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(from)
    || (tx.from !== undefined && tx.from.toLowerCase() !== from.toLowerCase())) {
    throw new WalletError('Wallet account changed. Reconnect before sending.');
  }
  if (tx.value !== '0x0') throw new WalletError('ARCHcore rental transactions must send zero native ETH.');
  const hash = await request(provider, 'eth_sendTransaction', [{ ...tx, from }]);
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new WalletError('Wallet returned no usable transaction hash.');
  }
  return hash;
}
