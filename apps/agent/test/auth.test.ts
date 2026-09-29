import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';

import {
  CHALLENGE_TYPES,
  SIGN_TYPES,
  EIP712_DOMAIN_TYPES,
  CHALLENGE_DOMAIN_NAME,
  CHALLENGE_DOMAIN_VERSION,
  ChallengeStore,
  buildDomain,
  typedDataPayload,
} from '../src/auth.js';
import type { Challenge, ChallengeDomain } from '../src/auth.js';

const PRIMARY_TYPE = Object.keys(CHALLENGE_TYPES)[0];

/**
 * Anvil default account #0 — the "renter". Its key is a well-known public
 * test value that ships with anvil/hardhat; it is never used to hold funds.
 */
const RENTER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CHAIN_ID = 46630;
const VERIFYING_CONTRACT = '0x' + 'cd'.repeat(20);
const AUDIENCE = 'https://pavilion.example.ts.net';
const renter = privateKeyToAccount(RENTER_KEY);

/**
 * Reproduce exactly what a browser does.
 *
 * A wallet receives the typed-data object over HTTP as JSON, so every integer
 * arrives as a decimal string, and it derives the domain separator from the
 * `types` map — which therefore must carry `EIP712Domain` itself, including the
 * `verifyingContract` field that binds the signature to this RentalManager
 * deployment. This helper builds that wallet-shaped object from the agent's own
 * exported constants, so a drift in `auth.ts` shows up here as a hash mismatch.
 */
function walletPayloadFor(challenge: {
  rentalId: string;
  nodeId: string;
  renter: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  chainId: number;
}) {
  return {
    domain: {
      name: CHALLENGE_DOMAIN_NAME,
      version: CHALLENGE_DOMAIN_VERSION,
      chainId: challenge.chainId,
      verifyingContract: VERIFYING_CONTRACT,
    },
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPES,
      ...CHALLENGE_TYPES,
    },
    primaryType: PRIMARY_TYPE,
    message: {
      renter: challenge.renter,
      rentalId: BigInt(challenge.rentalId).toString(),
      nodeId: BigInt(challenge.nodeId).toString(),
      nonce: challenge.nonce,
      issuedAt: BigInt(challenge.issuedAt).toString(),
      expiresAt: BigInt(challenge.expiresAt).toString(),
      agentAudience: AUDIENCE,
    },
  };
}

/**
 * What the wallet does with that JSON before it signs: the EIP-712 types
 * declare uint256/uint64, so it coerces the decimal strings back into bigints.
 * The agent does the same on the way in (see `typedDataPayload`), and getting
 * these two to agree is the whole point of this file.
 */
function asWalletWouldSign(payload: ReturnType<typeof walletPayloadFor>) {
  const { message, domain } = payload;
  return {
    domain: {
      ...domain,
      chainId: BigInt(domain.chainId),
      verifyingContract: domain.verifyingContract as `0x${string}`,
    },
    types: payload.types,
    primaryType: payload.primaryType as 'ComputeRWAAgentAuth',
    message: {
      renter: message.renter as `0x${string}`,
      rentalId: BigInt(message.rentalId),
      nodeId: BigInt(message.nodeId),
      nonce: message.nonce as `0x${string}`,
      issuedAt: BigInt(message.issuedAt),
      expiresAt: BigInt(message.expiresAt),
      agentAudience: message.agentAudience,
    },
  };
}

/** The server-side payload, in the same coerced shape so the two can be compared. */
function serverPayloadFor(domain: ChallengeDomain, challenge: Challenge) {
  const payload = typedDataPayload(domain, challenge);
  return {
    domain: { ...payload.domain, chainId: BigInt(payload.domain.chainId) },
    types: CHALLENGE_TYPES,
    primaryType: payload.primaryType,
    message: payload.message,
  };
}

describe('EIP-712 browser interop', () => {
  test('SIGN_TYPES carries the domain fields a wallet needs', () => {
    // Without EIP712Domain in the types map, eth_signTypedData_v4 has no
    // domain separator to work with.
    assert.equal(SIGN_TYPES.EIP712Domain, EIP712_DOMAIN_TYPES);
    // Every field the domain actually carries must be declared, in the order a
    // wallet hashes them: EIP-712 hashes the domain fields in the order the
    // types map declares them, and every major wallet emits
    // name, version, chainId, verifyingContract.
    assert.deepEqual(
      SIGN_TYPES.EIP712Domain.map((f) => f.name),
      ['name', 'version', 'chainId', 'verifyingContract'],
    );
    // The types map is forwarded verbatim to eth_signTypedData_v4; a stray
    // primaryType in it would be read as one more struct to hash.
    assert.equal('primaryType' in SIGN_TYPES, false);
    assert.deepEqual(
      (SIGN_TYPES as unknown as Record<string, readonly { name: string; type: string }[]>)[PRIMARY_TYPE].map(
        (f) => `${f.name}:${f.type}`,
      ),
      [
        'renter:address',
        'rentalId:uint256',
        'nodeId:uint256',
        'nonce:bytes32',
        'issuedAt:uint64',
        'expiresAt:uint64',
        'agentAudience:string',
      ],
    );
  });

  test('browser-shaped and server-shaped payloads hash identically', () => {
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    const domain = buildDomain(CHAIN_ID, VERIFYING_CONTRACT as `0x${string}`);
    const challenge: Challenge = {
      rentalId: '1',
      nodeId: '7',
      renter: renter.address,
      nonce,
      issuedAt: 1700000000,
      expiresAt: 1700000060,
      audience: AUDIENCE,
      consumed: false,
    };

    const browserHash = hashTypedData(
      asWalletWouldSign(walletPayloadFor({ ...challenge, chainId: CHAIN_ID })),
    );
    const serverHash = hashTypedData(serverPayloadFor(domain, challenge));

    assert.equal(
      browserHash,
      serverHash,
      'a failed hash match means wallet signatures will never recover on the agent',
    );
  });

  test('verifyingContract binds the signature to this RentalManager', () => {
    const names: string[] = EIP712_DOMAIN_TYPES.map((f) => f.name);
    // It is the RentalManager address, so a challenge minted against a manager
    // on another deployment cannot be replayed here even by the same renter.
    assert.equal(names.includes('verifyingContract'), true);
    const domain = buildDomain(CHAIN_ID, VERIFYING_CONTRACT as `0x${string}`);
    assert.equal(domain.verifyingContract, VERIFYING_CONTRACT);
  });

  test('a browser signature round-trips through agent recovery', async () => {
    const store = new ChallengeStore(300);
    const issued = store.issue({
      rentalId: '42',
      renter: renter.address,
      nodeId: '7',
      audience: AUDIENCE,
      now: Math.floor(Date.now() / 1000),
    });

    const signature = await renter.signTypedData(
      asWalletWouldSign(
        walletPayloadFor({
          rentalId: issued.rentalId,
          nodeId: issued.nodeId,
          renter: issued.renter,
          nonce: issued.nonce,
          issuedAt: issued.issuedAt,
          expiresAt: issued.expiresAt,
          chainId: CHAIN_ID,
        }),
      ),
    );

    // The agent recovers from the same struct, re-encoded server-side.
    const recovered = await recoverTypedDataAddress({
      domain: buildDomain(CHAIN_ID, VERIFYING_CONTRACT as `0x${string}`),
      types: CHALLENGE_TYPES,
      primaryType: PRIMARY_TYPE as 'ComputeRWAAgentAuth',
      message: {
        renter: issued.renter as `0x${string}`,
        rentalId: BigInt(issued.rentalId),
        nodeId: BigInt(issued.nodeId),
        nonce: issued.nonce as `0x${string}`,
        issuedAt: BigInt(issued.issuedAt),
        expiresAt: BigInt(issued.expiresAt),
        agentAudience: AUDIENCE,
      },
      signature,
    });

    assert.equal(recovered.toLowerCase(), renter.address.toLowerCase());
  });

  test('a signature from a different chain does not recover as the renter', async () => {
    const nonce = `0x${randomBytes(32).toString('hex')}`;

    // Signed for chain 1 (mainnet)…
    const signature = await renter.signTypedData(
      asWalletWouldSign(
        walletPayloadFor({
          rentalId: '1',
          nodeId: '7',
          renter: renter.address,
          nonce,
          issuedAt: 1700000000,
          expiresAt: 1700000060,
          chainId: 1,
        }),
      ),
    );

    // …but the agent verifies against chain 46630.
    const recovered = await recoverTypedDataAddress({
      domain: buildDomain(CHAIN_ID, VERIFYING_CONTRACT as `0x${string}`),
      types: CHALLENGE_TYPES,
      primaryType: PRIMARY_TYPE as 'ComputeRWAAgentAuth',
      message: {
        renter: renter.address,
        rentalId: 1n,
        nodeId: 7n,
        nonce: nonce as `0x${string}`,
        issuedAt: 1700000000n,
        expiresAt: 1700000060n,
        agentAudience: AUDIENCE,
      },
      signature,
    });

    assert.notEqual(recovered.toLowerCase(), renter.address.toLowerCase());
  });

  test('a signature minted for another RentalManager does not recover', async () => {
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    const domain = buildDomain(CHAIN_ID, VERIFYING_CONTRACT as `0x${string}`);
    const signature = await renter.signTypedData(
      asWalletWouldSign(
        walletPayloadFor({
          rentalId: '9',
          nodeId: '7',
          renter: renter.address,
          nonce,
          issuedAt: 1700000000,
          expiresAt: 1700000060,
          chainId: CHAIN_ID,
        }),
      ),
    );

    // Same renter, same chain, same message — only the RentalManager differs.
    const recovered = await recoverTypedDataAddress({
      domain: buildDomain(CHAIN_ID, ('0x' + 'ef'.repeat(20)) as `0x${string}`),
      types: CHALLENGE_TYPES,
      primaryType: PRIMARY_TYPE as 'ComputeRWAAgentAuth',
      message: {
        renter: renter.address,
        rentalId: 9n,
        nodeId: 7n,
        nonce: nonce as `0x${string}`,
        issuedAt: 1700000000n,
        expiresAt: 1700000060n,
        agentAudience: AUDIENCE,
      },
      signature,
    });

    assert.notEqual(recovered.toLowerCase(), renter.address.toLowerCase());
    assert.equal(domain.verifyingContract, VERIFYING_CONTRACT);
  });
});
