# ARCHcore P0 v0.5 integration runbook

This runbook defines execution and evidence only. [PRD v0.5](../ARCHcore_PRD_P0_v0.5_END_TO_END.md) is product authority; the [interface ledger](INTERFACE_CONTRACTS.md) is exact ABI/wire authority; [coordination README](README.md) defines ownership/work order. Archive all conflicting v0.4 build instructions; never adapt v0.5 to stale implementation.

## 1. Freeze and assign

Role 5 updates/validates ledger and `.env.example`, inventories active docs, maintains the v0.5 mismatch register, and assigns one prompt per implementator. Unknown deployment, signer, token decimals, and OmniRoute facts stay `UNKNOWN`/`BLOCKED`. No private key, credentialed RPC, token, signature, prompt or inference output is written to evidence.

## 2. Ordered implementation and integration

1. Role 1 implements both contract sources/tests from v0.5: soulbound Node 1, frozen USDG address, six-decimal preflight expectation, seven exact plan constants, plan snapshot, USDG transferFrom escrow, nonpayable `rent(nodeId,planId)`, provider snapshot, lifecycle/refund/settlement/events.
2. Role 2 waits for final source. Generate both ABI artifacts from Rust/Stylus; export twice and compare bytes. Test exact names/mutability/arguments/outputs/tuple positions/events. Reject payable/native-ETH `rent(uint256)`, forbidden `nodeIsRented`, old ten-field rental tuple, incorrect `getListing` price field, and any unsupported selector. Then implement normalized package calls including `getPlan`, token `decimals/balanceOf/allowance`, exact approval/rent writes and successful receipt handling.
3. Role 3 aligns Agent to normalized chain results, signer preflight, v0.5 EIP-712/session/HTTP schemas, quota/concurrency/timeout/abort, and explicit `INFERENCE_BACKEND_MODE=demo`. Runtime demo adapter is not a test fake or fallback.
4. Role 4 aligns Web to normalized chain results and Agent contract. Implement plan selection, USDG balance/allowance, exact approval then nonpayable plan rent, active lifecycle, auth, SSE and safe expiry behavior.
5. Role 5 integrates the actual merged tree and reruns all required gates; branch/copy test results alone are not integrated evidence.

Do not patch another role's files. Record each mismatch as: requirement; observed file/symbol/behavior; expected behavior; owner; required test/command; gate; status; unblock action.

## 3. Pre-deployment gates

Track each separately; no gate implies another:

- Rust format/host tests/linked-contract tests/WASM build/Stylus check;
- source-derived ABI export determinism and ABI/source/client conformance;
- chain package tests/typecheck/build and normalized decode/transaction tests;
- Agent tests/typecheck/lint/build and auth/session/signer/streaming safety tests;
- Web tests/typecheck/build and USDG approval/rent/UI lifecycle tests;
- security negatives and local link/config/secret checks;
- live token `decimals()==6` preflight;
- deployment, wallet, provider signer, OmniRoute route, full lifecycle/refund/settlement.

Record exact command, cwd, tool/version, exit code, case count and sanitized output. Use `PASS`, `FAIL`, `NOT RUN`, `NOT CONFIGURED`, `UNKNOWN`, `BLOCKED`. If a command cannot run or tests do not execute, say so explicitly.

## 4. USDG preflight and deployment

Before deployment acceptance, query the configured token on Robinhood Chain Testnet and prove its address matches `0x7E955252E15c84f5768B83c41a71F9eba181802F` and `decimals()==6`. A mismatch blocks deployment/use until the PRD and ledger are deliberately revised; never rescale. Confirm `paymentToken()` on RentalManager. Deploy linked ComputeAsset/RentalManager on chain `46630`, enroll only Node 1, verify plan count/values and all exact getters using generated ABI. Record only public addresses, transaction references and sanitized evidence.

Provider Agent signer must satisfy `signer.address == rental.provider`, where the provider is `ownerOf(1)` snapshotted during rent. Before `startRental`, require chain 46630, Node 1, RESERVED, `now < startDeadline`, signer ability/address, RPC/decode, Agent/demo readiness and successful simulation. After submission require successful mined receipt and reread ACTIVE.

For production deployment instructions of the Provider Agent with durable SQLite settlement journal, persistent volume mounts (`/var/lib/archcore/settlement.sqlite`), systemd service unit, and Docker Compose configuration, see [PROVIDER_AGENT_DEPLOYMENT.md](../deployment/PROVIDER_AGENT_DEPLOYMENT.md).

## 5. Live acceptance

Execute all acceptance scenarios in PRD §19 through the real private Browser→Agent OmniRoute path:

- Plan 1 standard six-hour rent: verify USDG balance, exact approval, allowance reread, `rent(1,1)`, exact 6 USDG escrow, provider snapshot, start, ACTIVE duration snapshot, EIP-712 auth and authenticated demo SSE.
- Plan 0 compressed full lifecycle: exact 0.10 USDG approval/escrow, start, infer, expiry denial/abort, permissionless settlement, exact frozen-provider payout and re-rent availability.
- Separate Plan 0 missed-start: no start, wait through 120-second deadline, permissionless cancellation, exact renter refund, terminal state and released occupancy.
- At least one security denial from PRD §19 (wrong wallet, replay/expired challenge, occupied node, or expired inference).

Label inference as simulated/demo; no physical GPU claim. Record sanitized tx references and assertions, never prompts/output/secrets. OmniRoute route must be actually proven from the renter path; config alone is not evidence.

## 6. Release definitions

Use PRD §§18 and 28 verbatim. `NOT READY`: local work/gates incomplete. `CODE-READY`: all required integrated local code/source/artifact/security gates pass against v0.5; no deployment/live claim. `DEMO-READY`: additionally all live chain/USDG preflight/wallet/signer/OmniRoute/Agent/auth/SSE/expiry/refund/settlement acceptance passes with sanitized reproducible evidence. Physical GPU, `nvidia-smi`, CUDA, telemetry and a real LLM are not required. Only Role 5 may declare these states, with the evidence register attached.
