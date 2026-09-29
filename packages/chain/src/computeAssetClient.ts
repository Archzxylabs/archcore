import {
  createPublicClient,
  defineChain,
  http,
  type PublicClient,
} from 'viem';
import { abiFunctionNames, loadAbi, resolveAbiPath, type Abi } from './abi';
import { asAddress, asBoolean } from './decode';
import type { Address } from '@archcore/shared';

export const COMPUTE_ASSET_METHODS = {
  ownerOf: 'ownerOf',
  isActive: 'isActive',
  nodeExists: 'nodeExists',
  nodeRetired: 'nodeRetired',
  owner: 'owner',
} as const;

export interface ComputeAssetConfig {
  chainId: number;
  rpcUrl: string;
  computeAssetAddress: string;
  abiDir?: string;
  computeAssetAbiPath?: string;
  publicClientOverride?: PublicClient;
}

export class ComputeAssetClient {
  readonly config: ComputeAssetConfig;
  readonly abi: Abi;
  private readonly publicClient: PublicClient;

  private constructor(config: ComputeAssetConfig, abi: Abi) {
    this.config = config;
    this.abi = abi;
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
  }

  static create(config: ComputeAssetConfig): ComputeAssetClient {
    const abiPath = resolveAbiPath('ComputeAsset', {
      explicitPath: config.computeAssetAbiPath,
      dir: config.abiDir,
    });
    const abi = loadAbi('ComputeAsset', {
      explicitPath: config.computeAssetAbiPath,
      dir: config.abiDir,
    });
    const available = new Set(abiFunctionNames(abi));
    for (const required of ['ownerOf', 'isActive'] as const) {
      if (!available.has(required)) {
        throw new Error(
          `ComputeAsset ABI at ${abiPath} is missing required method "${required}". Available: [${[...available].join(', ')}].`,
        );
      }
    }
    return new ComputeAssetClient(config, abi);
  }

  /**
   * `ownerOf(uint256 tokenId) external view returns (address)`
   */
  async ownerOf(tokenId: bigint): Promise<Address> {
    const result = await this.publicClient.readContract({
      address: this.config.computeAssetAddress as `0x${string}`,
      abi: this.abi as never,
      functionName: 'ownerOf',
      args: [tokenId] as never,
    });
    return asAddress(result, 'ownerOf');
  }

  /**
   * `isActive(uint256 tokenId) external view returns (bool)`
   */
  async isActive(tokenId: bigint): Promise<boolean> {
    const result = await this.publicClient.readContract({
      address: this.config.computeAssetAddress as `0x${string}`,
      abi: this.abi as never,
      functionName: 'isActive',
      args: [tokenId] as never,
    });
    return asBoolean(result, 'isActive');
  }

  /**
   * `nodeExists(uint256 tokenId) external view returns (bool)`
   */
  async nodeExists(tokenId: bigint): Promise<boolean> {
    const result = await this.publicClient.readContract({
      address: this.config.computeAssetAddress as `0x${string}`,
      abi: this.abi as never,
      functionName: 'nodeExists',
      args: [tokenId] as never,
    });
    return asBoolean(result, 'nodeExists');
  }

  /**
   * `nodeRetired(uint256 tokenId) external view returns (bool)`
   */
  async nodeRetired(tokenId: bigint): Promise<boolean> {
    const result = await this.publicClient.readContract({
      address: this.config.computeAssetAddress as `0x${string}`,
      abi: this.abi as never,
      functionName: 'nodeRetired',
      args: [tokenId] as never,
    });
    return asBoolean(result, 'nodeRetired');
  }
}
