/**
 * The one thing that talks to the chain's JSON-RPC endpoint.
 *
 * Reads and receipt-waits go through here, along with sending — the renter's
 * transactions and the wallet's own calls can take separate paths only if they
 * disagree about the endpoint, so all three take this one.
 *
 * Errors are reported with the method that failed and the node's own message. A
 * bare "RPC error" leaves the renter unable to tell a reverted read from an
 * unreachable node, and those need different actions.
 */

import { RpcError } from './config';
import type { RpcTransport } from './rentalOps';

export type { RpcTransport };

export function rpcTransport(rpcUrl: string): RpcTransport {
  let nextId = 1;
  return {
    request: async ({ method, params = [] }) => {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      });
      if (!response.ok) {
        throw new RpcError(`${method} failed with HTTP ${response.status}.`);
      }
      const body = (await response.json()) as {
        result?: unknown;
        error?: { message?: string; code?: number };
      };
      if (body.error) {
        throw new RpcError(`${method}: ${body.error.message ?? `code ${body.error.code ?? '?'}`}`);
      }
      return body.result;
    },
  };
}
