#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * One documented entrypoint for the contract-side plumbing the ABI/Chain owner
 * needs: toolchain checks, `cargo stylus check`, ABI export, and the Rust tests.
 *
 * Every command runs from `contracts/<crate>` because that is where a Stylus
 * contract is checked, exported and deployed from. Two crate-local facts are
 * enforced here rather than left to whoever runs the command:
 *
 * 1. `CARGO_TARGET_DIR=target` for `cargo stylus` commands. `cargo stylus check`
 *    resolves the wasm at `<cwd>/target/<triple>/release/deps`
 *    (cargo-stylus-0.6.3/src/project.rs), but a workspace member otherwise
 *    writes to the workspace root `target/`. For `test` and `fmt`, the workspace
 *    root `target/` is preserved to ensure test dependencies compile reproducibly.
 * 2. `rust-toolchain.toml` must exist in the crate dir. cargo-stylus reads the
 *    pin from the crate, not from the workspace root, and refuses to build wasm
 *    when it is missing. It is checked up front so the failure names the fix.
 *
 * Usage:
 *   npm run contracts:abi
 *   npm run contracts:check [-- --endpoint <url>]
 *   npm run contracts:test
 *   npm run contracts:fmt
 *   npm run contracts -- <check|abi|test|fmt|all> [--endpoint <url>] [contract ...]
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS_DIR = path.join(ROOT, 'contracts');
const PINNED_CHANNEL = '1.98.1';

const CONTRACTS = ['rental-manager', 'compute-asset'];

/** Artifact names as produced by `cargo stylus export-abi`. */
const ABI_FILES = {
  'rental-manager': 'RentalManager.json',
  'compute-asset': 'ComputeAsset.json',
};

const ABI_DIR = path.join(ROOT, 'packages', 'abi');

const DEFAULT_ENDPOINT = 'https://rpc.testnet.chain.robinhood.com';

function parseArgs(argv) {
  let endpoint = process.env.STYLUS_ENDPOINT || process.env.ARCHCORE_RPC_URL || process.env.RH_RPC_URL || process.env.RPC_URL || process.env.ENDPOINT || '';
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--endpoint') {
      if (i + 1 < argv.length) {
        endpoint = argv[++i];
      }
    } else if (arg.startsWith('--endpoint=')) {
      endpoint = arg.slice('--endpoint='.length);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    console.error(
      'usage: npm run contracts -- <check|abi|test|fmt|all> [--endpoint <url>] [contract ...]\n' +
        `contracts: ${CONTRACTS.join(' | ')} (all default)`,
    );
    process.exit(2);
  }

  const action = positional[0];
  const validActions = ['check', 'abi', 'test', 'linked-test', 'fmt', 'all'];
  if (!validActions.includes(action)) {
    console.error(`unknown action '${action}'; expected ${validActions.join(', ')}`);
    process.exit(2);
  }

  const requested = positional.slice(1);
  const unknown = requested.filter((name) => !CONTRACTS.includes(name));
  if (unknown.length > 0) {
    console.error(`unknown contract(s): ${unknown.join(', ')}`);
    process.exit(2);
  }

  const defaultTargets = action === 'linked-test' ? ['rental-manager'] : CONTRACTS;

  return {
    action,
    targets: requested.length > 0 ? requested : defaultTargets,
    endpoint: endpoint || DEFAULT_ENDPOINT,
    endpointSpecified: Boolean(endpoint),
  };
}

function cargoCommand(action, contractName, endpoint) {
  const cwd = path.join(CONTRACTS_DIR, contractName);
  if (action === 'fmt') {
    return { args: ['cargo', 'fmt', '--all', '--check'], cwd };
  }
  if (action === 'test') {
    return { args: ['cargo', 'test', '--', '--test-threads=1'], cwd };
  }
  if (action === 'linked-test') {
    return { args: ['cargo', 'test', '--test', 'linked_contracts', '--', '--test-threads=1'], cwd };
  }
  if (action === 'check') {
    return { args: ['cargo', 'stylus', 'check', '--endpoint', endpoint], cwd };
  }
  if (action === 'abi') {
    return { args: ['cargo', 'stylus', 'export-abi', '--json'], cwd };
  }
  throw new Error(`Unsupported action: ${action}`);
}

function run(cmd, action) {
  const capture = cmd.captureStdout === true;
  const env = { ...process.env };
  // cargo stylus commands resolve wasm from local crate target directory.
  // Tests and formatting use the workspace-level target to maintain dependency cache.
  if (action === 'check' || action === 'abi') {
    env.CARGO_TARGET_DIR = 'target';
  }

  const result = spawnSync(cmd.args[0], cmd.args.slice(1), {
    cwd: cmd.cwd,
    stdio: action === 'check' ? ['inherit', 'pipe', 'pipe'] : capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    env,
  });

  if (action === 'check') {
    // RPC paths and URL userinfo can contain operator credentials.
    const redact = (text) => String(text ?? '').split(endpoint).join(new URL(endpoint).hostname);
    process.stdout.write(redact(result.stdout));
    process.stderr.write(redact(result.stderr));
  }

  if (result.error) throw result.error;
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: capture ? result.stdout ?? '' : '',
  };
}

function parseAbiJson(contractName, stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) {
    throw new Error(`${contractName}: export-abi stdout contained no JSON ABI array`);
  }
  const abi = JSON.parse(stdout.slice(start, end + 1));
  if (!Array.isArray(abi)) {
    throw new Error(`${contractName}: export-abi JSON was not an array`);
  }
  return abi;
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Executes export-abi, validates JSON, writes artifact with deterministic
 * formatting, runs a second pass, and asserts byte-identical output & SHA-256.
 */
function exportAbiDeterministically(contractName) {
  console.log(`\n=== ${contractName}: export-abi (Pass 1) ===`);
  const cmd1 = cargoCommand('abi', contractName);
  const res1 = run({ ...cmd1, captureStdout: true }, 'abi');
  if (res1.status !== 0) {
    throw new Error(`${contractName}: export-abi Pass 1 failed with exit code ${res1.status}`);
  }

  const abi1 = parseAbiJson(contractName, res1.stdout);
  const formattedJson1 = `${JSON.stringify(abi1, null, 1)}\n`;
  const sha1 = sha256Hex(formattedJson1);

  const file = path.join(ABI_DIR, ABI_FILES[contractName]);
  writeFileSync(file, formattedJson1);

  const functions1 = abi1.filter((entry) => entry && entry.type === 'function').map((entry) => entry.name);
  console.log(`${contractName}: wrote ${path.relative(ROOT, file)} (${functions1.length} functions)`);
  console.log(`${contractName}: Pass 1 SHA-256 = ${sha1}`);

  console.log(`=== ${contractName}: export-abi (Pass 2 - determinism check) ===`);
  const cmd2 = cargoCommand('abi', contractName);
  const res2 = run({ ...cmd2, captureStdout: true }, 'abi');
  if (res2.status !== 0) {
    throw new Error(`${contractName}: export-abi Pass 2 failed with exit code ${res2.status}`);
  }

  const abi2 = parseAbiJson(contractName, res2.stdout);
  const formattedJson2 = `${JSON.stringify(abi2, null, 1)}\n`;
  const sha2 = sha256Hex(formattedJson2);
  console.log(`${contractName}: Pass 2 SHA-256 = ${sha2}`);

  if (sha1 !== sha2 || formattedJson1 !== formattedJson2) {
    throw new Error(
      `FATAL: Determinism check failed for ${contractName}! Pass 1 SHA: ${sha1} != Pass 2 SHA: ${sha2}`,
    );
  }

  const readBack = readFileSync(file, 'utf8');
  const readBackSha = sha256Hex(readBack);
  if (readBackSha !== sha1) {
    throw new Error(`FATAL: Disk verification failed for ${file}`);
  }

  console.log(`✓ ${contractName}: Deterministic ABI verified (SHA-256: ${sha1})`);
  return { sha: sha1, functions: functions1 };
}

function checkPin(contractName) {
  const pinPath = path.join(CONTRACTS_DIR, contractName, 'rust-toolchain.toml');
  if (!existsSync(pinPath)) {
    console.error(
      `\n${contractName}: ${path.relative(ROOT, pinPath)} is missing.\n` +
        `cargo stylus check/export-abi reads the toolchain pin from the crate directory, ` +
        `not the workspace root. Create it pinning channel = "${PINNED_CHANNEL}" to match ` +
        `the root pin, then re-run.`,
    );
    return false;
  }
  return true;
}

const { action, targets, endpoint } = parseArgs(process.argv.slice(2));
const actions = action === 'all' ? ['fmt', 'test', 'check', 'abi'] : [action];

const skippedPins = targets.filter((name) => !checkPin(name));
if (skippedPins.length === targets.length) process.exit(1);

const isLocalEndpoint = endpoint.includes('127.0.0.1') || endpoint.includes('localhost');
if (actions.includes('check')) {
  console.log(`\n======================================================================`);
  console.log(`Stylus Check Target Endpoint: ${new URL(endpoint).hostname} (${isLocalEndpoint ? 'LOCAL' : 'REMOTE'}; URL credentials redacted)`);
  console.log(`NOTICE: Stylus check validates compilation, WASM size, and onchain activation.`);
  console.log(`It is NOT a deployment to chain 46630 and provides no contract addresses.`);
  console.log(`======================================================================\n`);
}

const failures = [];
const abiResults = {};

for (const contractName of targets) {
  if (skippedPins.includes(contractName)) continue;
  for (const step of actions) {
    if (step === 'abi') {
      try {
        const res = exportAbiDeterministically(contractName);
        abiResults[contractName] = res;
      } catch (error) {
        console.error(String(error));
        failures.push(`${contractName} abi export failed`);
      }
      continue;
    }

    const cmd = cargoCommand(step, contractName, endpoint);
    console.log(`\n=== ${contractName}: ${cmd.args.map((arg) => arg === endpoint ? new URL(endpoint).hostname : arg).join(' ')} (in ${path.relative(ROOT, cmd.cwd)}) ===`);
    const result = run(cmd, step);
    console.log(`--- ${contractName} ${step}: exit ${result.status}`);
    if (result.status !== 0) {
      failures.push(`${contractName} ${step} (exit ${result.status})`);
    }
  }
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join('; ')}`);
  process.exit(1);
}

console.log('\nAll contract steps succeeded.');
