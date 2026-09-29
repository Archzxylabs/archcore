import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Node runtime loader for source-generated Stylus ABIs, owned by Role 2.
 *
 * Rules enforced here:
 * - the ABI is a file, never a hand-written literal;
 * - accepted shapes are the raw array, `{ abi: [...] }`, or `{ abi: [...], ... }`
 *   as produced by `cargo stylus export-abi`;
 * - a missing or malformed artifact is a hard error naming the path, so the
 *   Agent/web fail fast instead of guessing an interface.
 */
export type Abi = readonly unknown[];

export interface AbiEntry {
  type: string;
  name?: string;
  [key: string]: unknown;
}

const DEFAULT_DIR = path.resolve(__dirname, '../../abi');

export interface LoadAbiOptions {
  /** Explicit artifact path (from `RENTAL_MANAGER_ABI_PATH`). */
  explicitPath?: string;
  /** Directory of the artifact. Defaults to `packages/abi`. */
  dir?: string;
}

export function resolveAbiPath(contractName: string, options: LoadAbiOptions = {}): string {
  return (
    options.explicitPath ??
    path.join(options.dir ?? DEFAULT_DIR, `${contractName}.json`)
  );
}

export function loadAbi(contractName: string, options: LoadAbiOptions = {}): Abi {
  const filePath = resolveAbiPath(contractName, options);
  if (!existsSync(filePath)) {
    throw new Error(
      `ABI artifact not found for ${contractName} at ${filePath}. ` +
        `Role 2 must generate it with "npm run contracts:abi" ` +
        `(see packages/abi/README.md and docs/coordination/INTERFACE_CONTRACTS.md). ` +
        `Hand-written ABIs are not allowed for chain calls.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`ABI artifact for ${contractName} at ${filePath} is not valid JSON: ${String(error)}`);
  }

  const candidates: unknown[] = Array.isArray(parsed)
    ? [parsed]
    : parsed && typeof parsed === 'object' && 'abi' in (parsed as Record<string, unknown>)
      ? [(parsed as { abi: unknown }).abi]
      : [];

  const list = candidates.find((candidate) => Array.isArray(candidate));
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      `ABI artifact for ${contractName} at ${filePath} has no ABI array. ` +
        `Expected [...] or {"abi": [...]}.`,
    );
  }

  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || typeof (entry as AbiEntry).type !== 'string') {
      throw new Error(`ABI artifact for ${contractName} contains a non-ABI entry.`);
    }
  }

  return list as Abi;
}

/** Names of every function in an ABI, for startup validation and diagnostics. */
export function abiFunctionNames(abi: Abi): string[] {
  return abi
    .filter((entry): entry is AbiEntry => typeof entry === 'object' && entry !== null && (entry as AbiEntry).type === 'function')
    .map((entry) => entry.name ?? '<anonymous>');
}
