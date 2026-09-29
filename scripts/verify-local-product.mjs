/** Read-only documentation / shipped artifact checks. Never reads operator .env. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const documents = [
  'README.md',
  'docs/README.md',
  'docs/ARCHcore_PRD_P0_v0.5_END_TO_END.md',
  'docs/coordination/INTERFACE_CONTRACTS.md',
  'docs/coordination/INTEGRATION_RUNBOOK.md',
  'docs/deployment/PROVIDER_AGENT_DEPLOYMENT.md',
  'apps/agent/README.md',
];
let references = 0;
for (const document of documents) {
  const path = resolve(root, document);
  for (const match of readFileSync(path, 'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = match[1];
    if (/^(https?:|#)/.test(link)) continue;
    references++;
    assert.ok(existsSync(resolve(dirname(path), link.split('#')[0])), `${document}: missing ${link}`);
  }
}
const artifact = readFileSync(resolve(root, 'packages/abi/RentalManager.json'), 'utf8');
const functions = JSON.parse(artifact).filter((item) => item.type === 'function').map((item) => item.name);
assert.equal(functions.length, 11);
assert.ok(functions.includes('activeRentalForNode'));
assert.ok(!functions.includes('nodeIsRented'));
assert.ok(!functions.includes('getActiveRentalForNode'));
assert.equal(artifact, readFileSync(resolve(root, 'apps/web/public/rental-manager.json'), 'utf8'));
assert.doesNotMatch(readFileSync(resolve(root, 'apps/web/public/dist/app.js'), 'utf8'), /__dirname|node:fs|node:path/);
assert.doesNotMatch(readFileSync(resolve(root, 'apps/web/src/rentalOps.ts'), 'utf8'), /encodeFunctionData/);
console.log(`PASS ${references} local references across ${documents.length} current documents`);
console.log('PASS canonical selector, 11-function ABI, identical Web artifact, Node-global-free bundle, Chain-owned encoding');
