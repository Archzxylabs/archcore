# Provider Agent — ARCHcore P0 v0.5

The active product contract is [PRD v0.5](../../docs/ARCHcore_PRD_P0_v0.5_END_TO_END.md), with exact schemas in the [interface ledger](../../docs/coordination/INTERFACE_CONTRACTS.md). Do not use v0.4 implementation notes as instructions. Provider Agent is the only application authorization boundary; renter traffic reaches it via real private operator-configured OmniRoute. Agent invokes only the explicit local Demo Inference Backend selected by `INFERENCE_BACKEND_MODE=demo`.

P0 contract uses seven USDG plans and `rent(nodeId,planId)`; ETH is gas only. Before `startRental`, signer address must equal the provider snapshotted by the contract. Agent must use `packages/chain` normalized types and revalidate authoritative rental state before session issue and every inference. Exact API, auth, session, limits and SSE event contracts are in the ledger.

## Implementation boundaries

Current source, generated ABI and automated tests are the implementation evidence. Do not route renter requests directly to an inference backend, treat a test fake as runtime, invent GPU telemetry, or claim live OmniRoute readiness from local tests.

## Local development

```sh
cd archcore
npm run build
AGENT_HOST=127.0.0.1 AGENT_PORT=8787 AGENT_ALLOWED_ORIGINS=http://localhost:8787 AGENT_AUDIENCE=http://localhost:8787 AGENT_AUTO_START=false INFERENCE_BACKEND_MODE=demo npm run start -w @archcore/agent
```

Open `http://localhost:8787`; Agent serves the built Web. Existing operator `.env` is loaded only at explicit runtime startup, into a cloned environment. Importing modules never loads it. Do not overwrite or delete it. Secret signer configuration is server-side and uncommitted; never put private keys, credentialed RPC URLs, bearer tokens, signatures, prompts or generated output in Git or logs. The command disables provider transaction auto-start. Enabling it is a separate operator-authorized live step. Physical GPU is not needed for P0. Local work does not prove OmniRoute connectivity; it is deferred here.

Run `npm run test:agent:hermetic` from the root to verify the entire suite in both simulated operator-file modes with deliberately conflicting process values. The actual file must remain byte-identical. See the [root README](../../README.md) for full local startup, browser QA and read-only deployment verification.
