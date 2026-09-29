# ARCHcore

**The active P0 product authority is [ARCHcore PRD P0 v0.5 End-to-End](docs/ARCHcore_PRD_P0_v0.5_END_TO_END.md).** Developers should also read the [documentation index](docs/README.md), [interface ledger](docs/coordination/INTERFACE_CONTRACTS.md), [integration runbook](docs/coordination/INTEGRATION_RUNBOOK.md), and [Provider Agent deployment guide](docs/deployment/PROVIDER_AGENT_DEPLOYMENT.md).

P0 uses Robinhood Chain Testnet (`46630`), Stylus contracts, USDG plan-based escrow, and native ETH for gas only. Plan 0 is the five-minute testnet demo; Plans 1–6 are fixed commercial plans. The renter reaches Provider Agent over private operator-configured OmniRoute. P0 inference is explicitly simulated by the Demo Inference Backend; physical GPU execution is not required.

Current implementation uses the v0.5 interfaces. Repository tests and generated artifacts are the implementation evidence; private prompts, handoffs, transcripts, historical PRDs, and timestamped work reports are intentionally excluded from the public repository.

## Run the local product

Prerequisites: Node.js 20.11+ / npm; existing operator configuration in `apps/agent/.env` or the process environment. Do not overwrite an existing `.env` with the example. The current Agent requires `RENTAL_MANAGER_ADDRESS` and an operator-managed `PROVIDER_PRIVATE_KEY`; use the already provisioned testnet signer, never a key copied from a report. Set `COMPUTE_ASSET_ADDRESS` for the read-only preflight. The signer must match Node 1's provider; the renter browser uses its own wallet, never that key.

From a terminal:

```bash
cd archcore
npm install
npm run build
AGENT_HOST=127.0.0.1 \
AGENT_PORT=8787 \
AGENT_ALLOWED_ORIGINS=http://localhost:8787 \
AGENT_AUDIENCE=http://localhost:8787 \
AGENT_AUTO_START=false \
INFERENCE_BACKEND_MODE=demo \
npm run start -w @archcore/agent
```

Open **http://localhost:8787**. Agent serves the built Web and its API together; a separate Python static server is unnecessary. Keep this terminal running. Stop with Ctrl+C. If port 8787 is already occupied, use the existing Agent or stop your old process; do not kill unrelated processes. Use `localhost` consistently with the audience/origin above.

This startup is deliberately read-only for the provider watcher: `AGENT_AUTO_START=false` prevents automatic `startRental` sends. Viewing plans and connecting a wallet do not approve USDG or rent. Clicking approval/rent/refund/settlement requests a real testnet wallet transaction; review it before signing. To authorize automatic provider starts for an intended real testnet rental, restart with `AGENT_AUTO_START=true` after checking the signer, funds and deployment. That is a separate operator-authorized live step, not something local QA performs.

The renter journey is: connect wallet → switch to chain 46630 → select a plan → approve the exact USDG amount if needed → wait for its successful receipt → rent → wait for provider start → authenticate by signing the exact Agent challenge → generate/cancel. Reserved rentals missing their start deadline expose a refund; expired ACTIVE rentals expose settlement. Every transaction waits for a mined successful receipt and a fresh chain read. Native ETH pays gas only.

Plan 0 is explicitly `TESTNET DEMO / 5 MINUTES`. Standard plans begin at six hours. Inference is explicitly simulated, but authorization, wallet, escrow and chain lifecycle are not silently replaced by mocks. No hardware metrics are invented. The finished private Browser → OmniRoute → Agent boundary remains required for the final demo; **OmniRoute verification is DEFERRED for this local-product assignment**.

## Reproduce verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:agent:hermetic
npx playwright-core install chromium
npm run qa:local-product
npm run verify:local-product
npm run contracts:fmt
npm run contracts:test
npm run contracts:linked-test
npm run contracts:abi
npm run contracts:check
npm run preflight:readonly
```

Browser QA uses a disposable public TEST wallet and intercepted TEST RPC, the shipped browser bundle, and actual loopback Agent HTTP/auth/session/demo SSE. It never sends live transactions and is not live-chain E2E evidence. The hermetic test runner simulates the operator file being present/absent without changing it. `preflight:readonly` uses existing operator configuration to read the actual deployment and verify USDG/plan/node/signer-address consistency; it never signs or sends. Stylus check uses the public Robinhood RPC by default; server-side `STYLUS_ENDPOINT`, `ARCHCORE_RPC_URL` or `RH_RPC_URL` may override it without exposing their credentials to Web.

Root lint runs configured workspace scripts; Web has no lint script and its required gates are tests/typecheck/build. Agent's current lint script is strict TypeScript checking, not an ESLint claim. Browser-safe custom RPC/explorer configuration must be credential-free origins only; use matching `NEXT_PUBLIC_RH_RPC_URL` for Web build and Agent startup/CSP. `/config` never publishes the private server RPC.
