/** Browser boundary tests use synthetic URLs/accounts only, never operator credentials. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAgentConfig } from '../src/config';
import { sendTransaction } from '../src/wallet';
import { streamInference } from '../src/inference';

describe('local product browser safety', () => {
  it('ignores server-supplied credentialed RPC/explorer fields', () => {
    const config = parseAgentConfig({ chainId: 46630, nodeId: '1', rentalManager: `0x${'22'.repeat(20)}`,
      rpcUrl: 'https://user:TEST_SECRET@rpc.example/TEST_SECRET', explorerUrl: 'https://user:TEST_SECRET@explorer.example',
      interfaceVersion: '0.5', inferenceMode: 'demo' });
    assert.equal(config.rpcUrl, 'https://rpc.testnet.chain.robinhood.com');
    assert.equal(config.explorerUrl, 'https://explorer.testnet.chain.robinhood.com');
  });
  it('rejects credentialed public build input before producing a bundle or printing its value', () => {
    const result = spawnSync(process.execPath, ['build.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
      env: { ...process.env, NEXT_PUBLIC_RH_RPC_URL: 'https://rpc.example/TEST_SECRET' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /credential-free/); assert.doesNotMatch(result.stderr, /TEST_SECRET/);
  });
  it('rejects an account change before opening a transaction request', async () => {
    let sends = 0;
    const provider = { request: async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return [`0x${'33'.repeat(20)}`];
      sends++; throw Error('Should never send');
    } };
    await assert.rejects(sendTransaction(provider, { from: `0x${'11'.repeat(20)}`, to: `0x${'22'.repeat(20)}`, data: '0x', value: '0x0' }), /account changed/);
    assert.equal(sends, 0);
  });
  it('refuses nonzero native value at the wallet boundary', async () => {
    let sends = 0;
    const provider = { request: async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return [`0x${'11'.repeat(20)}`];
      sends++; throw Error('Should never send');
    } };
    await assert.rejects(sendTransaction(provider, { to: `0x${'22'.repeat(20)}`, data: '0x', value: '0x1' }), /zero native ETH/);
    assert.equal(sends, 0);
  });
  it('never accepts a JSON success body as a successful inference stream', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"output":"fake success"}', { headers: { 'content-type': 'application/json' } });
    try {
      await assert.rejects(async () => {
        for await (const _text of streamInference('http://test-agent', 'test-token', { prompt: 'TEST' }, new AbortController().signal)) {
          assert.fail('No output should be accepted');
        }
      }, /SSE protocol/);
    } finally { globalThis.fetch = original; }
  });
});
