import type { ChainConfig, MethodName } from './rentalManagerClient';
import { DEFAULT_METHODS } from './rentalManagerClient';

/** Operator configuration. Product selectors and tuple order are not configurable. */
export const CHAIN_ENV_KEYS = [
  'RH_CHAIN_ID',
  'RH_RPC_URL',
  'RH_EXPLORER_URL',
  'RENTAL_MANAGER_ADDRESS',
  'COMPUTE_ASSET_ADDRESS',
  'ARCHCORE_NODE_ID',
  'PROVIDER_PRIVATE_KEY',
  'RENTAL_MANAGER_ABI_PATH',
  'COMPUTE_ASSET_ABI_PATH',
] as const;

export function loadChainConfig(env: NodeJS.ProcessEnv = process.env): ChainConfig {
  if (Number(env.RH_CHAIN_ID ?? 46630) !== 46630) throw new Error('RH_CHAIN_ID must be 46630.');
  if ((env.ARCHCORE_NODE_ID ?? '1') !== '1') throw new Error('ARCHCORE_NODE_ID must be 1.');
  for (const key of ['RENTAL_STATUS_ORDER', 'RENTAL_FIELDS_ORDER', 'NODE_FIELDS_ORDER', 'LISTING_FIELDS_ORDER', 'PLAN_FIELDS_ORDER']) {
    if (env[key]) throw new Error(`${key} cannot override the frozen v0.5 ABI interpretation.`);
  }
  for (const key of Object.keys(DEFAULT_METHODS) as MethodName[]) {
    if (env[`RM_METHOD_${key.toUpperCase()}`]) throw new Error('Production method names cannot be overridden.');
  }
  const abiDir = env.ARCHCORE_ABI_DIR ? env.ARCHCORE_ABI_DIR : undefined;
  return {
    chainId: Number(env.RH_CHAIN_ID ?? 46630),
    rpcUrl: env.RH_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com',
    rentalManagerAddress: env.RENTAL_MANAGER_ADDRESS ?? '',
    computeAssetAddress: env.COMPUTE_ASSET_ADDRESS || undefined,
    nodeId: BigInt(env.ARCHCORE_NODE_ID ?? '1'),
    providerPrivateKey: (env.PROVIDER_PRIVATE_KEY as `0x${string}` | undefined) || undefined,
    abiDir,
    rentalManagerAbiPath: env.RENTAL_MANAGER_ABI_PATH || undefined,
    computeAssetAbiPath: env.COMPUTE_ASSET_ABI_PATH || undefined,
    explorerUrl: env.RH_EXPLORER_URL || undefined,
  };
}
