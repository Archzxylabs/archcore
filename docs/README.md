# ARCHcore documentation entry point

## Product documentation

1. [ARCHcore P0 v0.5 End-to-End PRD](ARCHcore_PRD_P0_v0.5_END_TO_END.md) — product requirements and acceptance criteria.
2. [Interface ledger](coordination/INTERFACE_CONTRACTS.md) — exact ABI, tuple, HTTP/auth and SSE contracts.
3. [Integration runbook](coordination/INTEGRATION_RUNBOOK.md) — local validation and release procedure.
4. [Provider Agent deployment](deployment/PROVIDER_AGENT_DEPLOYMENT.md) — durable state, service and volume configuration.
5. Current source, generated ABI and automated tests — implementation evidence.

Internal prompts, agent handoffs, checkpoints, transcripts and superseded PRDs are intentionally excluded from the public repository.

## P0 at a glance

ARCHcore targets Robinhood Chain Testnet (`46630`) with Rust/Arbitrum Stylus contracts. The renter pays USDG—not ETH—using one of seven immutable plans: a five-minute 0.10 USDG testnet demo and six commercial plans starting at six hours. ETH is gas only. Node 1 is the sole P0 node; the provider is snapshotted at reservation; missed starts refund 100%; expired active rentals settle 100% to that provider.

Provider Agent remains the sole inference authorization boundary, reached through a real operator-configured private OmniRoute route. P0 inference uses explicit `INFERENCE_BACKEND_MODE=demo`, with simulated/local output; it is not a test fake or fallback. Physical GPU is not required. Follow the PRD for exact selectors, tuple layouts, HTTP schemas, limits, acceptance, and readiness. Do not infer readiness from documentation edits.
