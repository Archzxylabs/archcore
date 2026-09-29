/** Browser ABI loader: generated JSON artifacts, no Node globals or filesystem.
 * The Web bundler selects this module instead of the Node artifact loader.
 */
import rentalManager from '../../abi/RentalManager.json';
import computeAsset from '../../abi/ComputeAsset.json';
import type { Abi, AbiEntry, LoadAbiOptions } from './abi';

const artifacts: Record<string, Abi> = { RentalManager: rentalManager, ComputeAsset: computeAsset };

export function resolveAbiPath(name: string, options: LoadAbiOptions = {}): string {
  if (options.dir || options.explicitPath) throw new Error('Browser ABI path overrides are not supported.');
  if (!Object.hasOwn(artifacts, name)) throw new Error('Unknown generated ABI artifact.');
  return `generated:${name}.json`;
}

export function loadAbi(name: string, options: LoadAbiOptions = {}): Abi {
  resolveAbiPath(name, options);
  return artifacts[name]!;
}

export function abiFunctionNames(abi: Abi): string[] {
  return abi.filter((entry): entry is AbiEntry => typeof entry === 'object' && entry !== null
    && (entry as AbiEntry).type === 'function').map((entry) => entry.name ?? '<anonymous>');
}
