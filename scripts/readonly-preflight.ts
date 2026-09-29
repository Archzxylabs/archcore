/** Operator-configured READ-ONLY verification. Never signs, simulates, or sends transactions. */
import assert from 'node:assert/strict';
import { loadRuntimeConfig } from '../apps/agent/src/config';
import { RentalManagerClient, ComputeAssetClient } from '../packages/chain/src/index';
import { USDG_ADDRESS, FROZEN_PLANS } from '../packages/shared/src/index';

async function main() {
  const config = loadRuntimeConfig({ ...process.env, AGENT_AUDIENCE: 'http://localhost:8787',
    AGENT_ALLOWED_ORIGINS: 'http://localhost:8787', AGENT_AUTO_START: 'false' });
  assert.ok(config.chain.computeAssetAddress, 'ComputeAsset address is required for preflight.');
  const rental = RentalManagerClient.create(config.chain);
  const compute = ComputeAssetClient.create({ ...config.chain, computeAssetAddress: config.chain.computeAssetAddress });
  const [chainId, metadata, token, count, node, listing, owner, active, rentalCode, computeCode] = await Promise.all([
    rental.client.getChainId(), rental.getPaymentTokenMetadata(USDG_ADDRESS), rental.paymentToken(), rental.planCount(),
    rental.getNode(1n), rental.getListing(1n), compute.ownerOf(1n), compute.isActive(1n),
    rental.client.getCode({ address: config.chain.rentalManagerAddress as `0x${string}` }),
    rental.client.getCode({ address: config.chain.computeAssetAddress as `0x${string}` }),
  ]);
  assert.equal(chainId, 46630); assert.equal(metadata.decimals, 6);
  assert.equal(token.toLowerCase(), USDG_ADDRESS.toLowerCase()); assert.equal(count, 7);
  assert.ok(rentalCode && rentalCode !== '0x'); assert.ok(computeCode && computeCode !== '0x');
  assert.equal(node.provider.toLowerCase(), owner.toLowerCase());
  assert.equal(node.active, active); assert.equal(rental.providerAddress?.toLowerCase(), owner.toLowerCase());
  const plans = await Promise.all(FROZEN_PLANS.map((plan) => rental.getPlan(plan.planId)));
  assert.deepEqual(plans, FROZEN_PLANS);
  console.log(JSON.stringify({ mode: 'READ ONLY; NO TRANSACTIONS', rpcHost: new URL(config.chain.rpcUrl).hostname,
    chainId, paymentToken: token, decimals: metadata.decimals, rentalManager: config.chain.rentalManagerAddress,
    computeAsset: config.chain.computeAssetAddress, node, listing, nodeOwner: owner, nodeActive: active,
    providerSignerMatches: true, plans }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
}
void main().catch(() => {
  // RPC exceptions and assertion details may contain operator configuration.
  console.error('FAIL read-only preflight. Verify network, contract addresses, token metadata, Node 1 and provider signer locally. No transaction was sent.');
  process.exitCode = 1;
});
