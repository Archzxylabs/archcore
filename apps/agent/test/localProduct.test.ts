import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DemoInferenceBackend } from '../src/adapter';
import { InferenceClient } from '../src/inference';
import { HealthMonitor } from '../src/health';
import { DEFAULT_LIMITS } from '@archcore/shared';
import type { AgentConfig } from '../src/config';

describe('hermetic configuration import boundary', () => {
  for (const denyOperatorReads of [false, true]) {
    it(`does not read operator .env or validate operator values during import (reads blocked=${denyOperatorReads})`, () => {
      const script = `
        import fs from 'node:fs';
        import {syncBuiltinESMExports} from 'node:module';
        import assert from 'node:assert/strict';
        const before = {...process.env};
        const original = fs.readFileSync;
        if (${denyOperatorReads}) {
          fs.readFileSync = (file, ...args) => {
            if (String(file).endsWith('/.env')) throw Error('Operator .env access forbidden in tests');
            return original(file, ...args);
          };
          syncBuiltinESMExports();
        }
        await import('./src/config.ts');
        await import('./src/server.ts');
        assert.deepEqual({...process.env}, before);
      `;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: resolve(__dirname, '..'), encoding: 'utf8',
        env: { ...process.env, RH_CHAIN_ID: '1', RENTAL_MANAGER_ADDRESS: 'operator-value-not-a-fixture',
          PROVIDER_PRIVATE_KEY: 'intentionally-invalid-test-value', AGENT_AUDIENCE: 'invalid-test-value' },
      });
      assert.equal(result.status, 0, result.stderr); // Only synthetic values are used in child diagnostics.
    });
  }
});

describe('explicit runnable Demo Inference Backend', () => {
  it('streams bounded demo output and identifies simulation honestly', async () => {
    const backend = new DemoInferenceBackend();
    assert.equal((await backend.checkReadiness()).ok, true);
    const result = await new InferenceClient(backend, DEFAULT_LIMITS).generateStream({
      model: backend.model, prompt: 'Disposable test prompt',
    }, new AbortController().signal);
    assert.equal(result.model, 'archcore-demo-simulated');
    assert.match(result.output, /simulated/);
    assert.ok(result.output.split(/\s+/).length <= 256);
  });

  it('propagates abort without calling completion', async () => {
    const backend = new DemoInferenceBackend();
    const controller = new AbortController();
    let completed = false;
    await assert.rejects(new InferenceClient(backend, DEFAULT_LIMITS).generateStream({
      model: backend.model, prompt: 'Disposable test prompt',
    }, controller.signal, { onDelta: () => controller.abort(), onComplete: () => { completed = true; } }));
    assert.equal(completed, false);
  });

  it('demo health never invokes physical GPU detection and configured RPC alone is unknown', async () => {
    const config = { inferenceMode: 'demo', chain: { rpcUrl: 'https://rpc.example' }, host: '127.0.0.1', port: 8787 } as AgentConfig;
    const monitor = new HealthMonitor(config, new DemoInferenceBackend(), async () => {
      throw Error('Physical GPU detection must not run in demo mode');
    });
    const checks = await monitor.checks();
    assert.equal(checks.find((check) => check.name === 'gpu')?.status, 'unknown');
    assert.equal(checks.find((check) => check.name === 'rpc')?.status, 'unknown');
    assert.equal(checks.find((check) => check.name === 'backend')?.status, 'ok');
  });
});
