# ARCHcore

**Lease compute. Settle onchain.**

ARCHcore is a compute-leasing protocol on Robinhood Chain Testnet. A renter selects an immutable plan, locks USDG in a Rust/Arbitrum Stylus escrow contract, receives wallet-bound access through EIP-712 authentication, and loses access automatically when the lease expires.

The payment, escrow, rental lifecycle, authentication, access enforcement, refund, and settlement paths are real. P0 model execution uses an explicitly labelled Demo Inference Backend; it does not claim physical GPU execution or hardware attestation.

## Why ARCHcore

Offchain compute marketplaces need more than a payment button. They need a shared source of truth for who may use a node, for how long, under which price, and where escrow goes when a provider starts late or a lease expires.

ARCHcore combines:

- a soulbound onchain identity for Compute Node 1;
- seven immutable USDG-denominated rental plans;
- exclusive node occupancy and time-bounded access rights;
- missed-start refunds and expired-rental settlement;
- provider-controlled Agent authorization with exact EIP-712 challenges;
- memory-only sessions, request quotas, concurrency limits, cancellation, and expiry enforcement;
- crash-safe automatic settlement backed by a durable SQLite journal.

## Architecture

```text
Renter wallet and browser
        │
        ├── USDG approve / rent / refund / settlement
        ▼
Robinhood Chain Testnet (46630)
  ComputeAsset + RentalManager (Rust / Stylus)
        ▲
        │ authoritative rental validation
        ▼
Provider Agent
  EIP-712 auth → memory-only session → quota/expiry guard
        │
        ▼
Explicit Demo Inference Backend
```

The intended production transport is `Browser → private OmniRoute → Provider Agent`. OmniRoute provisioning is operator infrastructure and is not represented as completed by local tests.

## Live testnet deployment

| Component | Address / value |
|---|---|
| Network | Robinhood Chain Testnet |
| Chain ID | `46630` |
| ComputeAsset | `0xa87bc4d22a302c0dc082f0ed70bb530f3476b71f` |
| RentalManager | `0x9b45526c710259d72777d8844953bb696e4b68df` |
| USDG | `0x7E955252E15c84f5768B83c41a71F9eba181802F` |
| Node | `1` |
| Plan 0 | `5 minutes / 0.10 USDG` |

Testnet assets have no monetary value. Contract addresses are public identifiers; provider signing material is never committed or returned to the browser.

## Rental journey

```text
Connect wallet
  → switch to Robinhood Chain Testnet
  → select a plan
  → approve exact USDG amount when required
  → rent Node 1
  → provider starts the reservation
  → sign the EIP-712 access challenge
  → stream or cancel inference
  → expiry closes access
  → escrow settles to the frozen provider
  → Node 1 becomes available again
```

If the provider misses the start deadline, the renter can recover 100% of the escrow. Every transaction flow waits for a successful receipt and then rereads authoritative chain state.

## What is real and what is simulated

| Surface | P0 status |
|---|---|
| Stylus contracts and deployment | Real testnet |
| USDG escrow and payouts | Real testnet |
| Wallet transactions and receipts | Real testnet |
| EIP-712 authentication | Real |
| Agent session and rental enforcement | Real |
| Automatic settlement and restart recovery | Real Agent implementation |
| Model computation | Explicitly simulated |
| Physical GPU attestation | Not implemented |
| OmniRoute deployment verification | Operator-deferred |

## Repository layout

```text
contracts/             Rust / Stylus ComputeAsset and RentalManager
packages/abi/          Source-generated contract ABI
packages/chain/        Canonical TypeScript contract client and decoders
packages/shared/       Shared protocol types, limits, errors, and redaction
apps/agent/            Provider Agent, auth, lifecycle watcher, and journal
apps/web/              Renter application
scripts/               ABI, QA, preflight, and verification tooling
docs/                  Active product, interface, and deployment documentation
```

## Quick start

Requirements:

- Node.js `22.13+` (Node.js 24 recommended; the Agent uses built-in `node:sqlite`);
- npm;
- Rust `1.98.1` through the pinned toolchain for contract work;
- a browser wallet configured for Robinhood Chain Testnet.

```bash
git clone https://github.com/Archzxylabs/archcore.git
cd archcore
npm ci
npm run build
```

Create an uncommitted Agent configuration from [.env.example](.env.example). Keep `PROVIDER_PRIVATE_KEY` and any credentialed RPC URL server-side. For a loopback demo, set:

```dotenv
AGENT_HOST=127.0.0.1
AGENT_PORT=8787
AGENT_ALLOWED_ORIGINS=http://localhost:8787
AGENT_AUDIENCE=http://localhost:8787
INFERENCE_BACKEND_MODE=demo
AGENT_AUTO_START=false
AGENT_AUTO_SETTLE=false
```

Also provide the deployed contract addresses and an operator-managed provider signer in `apps/agent/.env` or the process environment. Then start the built application:

```bash
npm run start -w @archcore/agent
```

Open [http://localhost:8787](http://localhost:8787). The Agent serves both the API and the built renter Web.

`AGENT_AUTO_START` and `AGENT_AUTO_SETTLE` authorize provider transactions that spend testnet gas. Leave both disabled until the signer, deployment, balance, and intended rental have been checked. See the [Provider Agent deployment guide](docs/deployment/PROVIDER_AGENT_DEPLOYMENT.md) for persistent journal and service configuration.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:agent:hermetic
npm run qa:local-product
npm run verify:local-product
npm run contracts:fmt
npm run contracts:test
npm run contracts:linked-test
npm run contracts:abi
npm run contracts:check
npm run preflight:readonly
```

Browser QA uses a disposable test wallet and intercepted test RPC; it is not presented as live-chain E2E evidence. `preflight:readonly` reads the configured deployment without signing or sending transactions. Commands that use operator configuration must never print or commit its contents.

## Security model

- no private key, RPC credential, session token, signature, prompt, or model output is exposed through `/config`;
- session tokens are held in memory and stored server-side only by digest;
- the Agent revalidates the rental before authentication and inference;
- unknown or unavailable dependencies fail closed;
- auto-settlement defaults off and passes every broadcast through a hard kill switch;
- the SQLite journal stores transaction recovery metadata, never signer material;
- production logs use structured redaction.

## Documentation

- [P0 v0.5 product requirements](docs/ARCHcore_PRD_P0_v0.5_END_TO_END.md)
- [Interface contracts](docs/coordination/INTERFACE_CONTRACTS.md)
- [Integration runbook](docs/coordination/INTEGRATION_RUNBOOK.md)
- [Provider Agent deployment](docs/deployment/PROVIDER_AGENT_DEPLOYMENT.md)
- [Documentation index](docs/README.md)

Internal prompts, AI transcripts, role handoffs, historical reports, operator state, and credentials are intentionally excluded from the public repository.
