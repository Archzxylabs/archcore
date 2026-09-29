/** Entire Agent suite with operator file visible vs simulated absent; never edits it. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cwd = resolve(root, 'apps/agent');
const operatorPath = resolve(cwd, '.env');
const before = existsSync(operatorPath) ? readFileSync(operatorPath) : null;
const tests = readdirSync(resolve(cwd, 'test')).filter((name) => name.endsWith('.test.ts')).map((name) => `test/${name}`);
for (const mode of ['present', 'absent']) {
  const result = spawnSync(process.execPath, ['--require', resolve(root, 'scripts/hermetic-agent-env.cjs'),
    '--test', '--import', 'tsx', ...tests], {
    cwd, encoding: 'utf8', env: { ...process.env,
      ARCHCORE_TEST_OPERATOR_ENV: mode,
      RH_CHAIN_ID: '1', RENTAL_MANAGER_ADDRESS: 'deliberately-not-the-test-fixture',
      PROVIDER_PRIVATE_KEY: 'deliberately-invalid-TEST-value', AGENT_AUDIENCE: 'invalid-TEST-origin',
    },
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `Agent suite failed with operator file mode ${mode}`);
  console.log(`PASS hermetic Agent suite: operator file ${mode}; contradictory process values; operator reads forbidden`);
}
const after = existsSync(operatorPath) ? readFileSync(operatorPath) : null;
assert.equal(before === null ? after === null : after !== null && before.equals(after), true);
console.log('PASS operator .env unchanged (no file contents or digest disclosed)');
