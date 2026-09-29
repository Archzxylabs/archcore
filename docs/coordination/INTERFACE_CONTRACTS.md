# ARCHcore P0 v0.5 interface ledger

This is the exact cross-role contract subordinate only to [PRD v0.5](../ARCHcore_PRD_P0_v0.5_END_TO_END.md). It is maintained by Role 5. If source, generated ABI, application code, or an old report differs, log an implementation mismatch and route it to its owner; do not reinterpret the PRD. This ledger freezes raw interfaces, wire schemas, and decoding ownership.

## 1. Fixed chain/payment/product values

| Field | Canonical value |
|---|---|
| Network / chain ID | Robinhood Chain Testnet / `46630` |
| Contracts | Rust / Arbitrum Stylus |
| P0 node | ComputeAsset Node ID `1`, one provider identity |
| Payment asset | USDG `0x7E955252E15c84f5768B83c41a71F9eba181802F`; deployment preflight requires `decimals() == 6` |
| Native asset | Testnet ETH for gas only; never rental escrow |
| Occupancy | One `RESERVED` or `ACTIVE` rental for Node 1 |
| Plan catalog | Seven immutable contract-defined plans; no setters, constructor overrides, or environment economics |
| Inference | One concurrent inference; explicit `INFERENCE_BACKEND_MODE=demo`; simulated/local output; no physical GPU requirement |
| Private path | Renter Browser → operator-configured private OmniRoute → Provider Agent; no browser-to-backend path |

Exact plan table (atomic prices assume the required six-decimal token preflight):

| planId | Name | durationSeconds | priceAtomic | active | demoOnly |
|---:|---|---:|---:|---|---|
| 0 | Testnet Demo | 300 | 100000 | true | true |
| 1 | 6 Hours | 21600 | 6000000 | true | false |
| 2 | 12 Hours | 43200 | 11400000 | true | false |
| 3 | 24 Hours | 86400 | 21600000 | true | false |
| 4 | 7 Days | 604800 | 142800000 | true | false |
| 5 | 14 Days | 1209600 | 268800000 | true | false |
| 6 | 30 Days | 2592000 | 504000000 | true | false |

`planCount()` is `7`. Plan 0 is visibly TESTNET DEMO; the commercial minimum is Plan 1. No plan activation or listing CRUD exists. Plan values are snapshotted into each rental.

## 2. Production RentalManager ABI

Required P0 functions and exact mutability:

```text
paymentToken() view returns (address)
planCount() view returns (uint8)
getPlan(uint8 planId) view returns (uint8,uint256,uint256,bool,bool)
getNode(uint256 nodeId) view returns (uint256,address,bytes32,bool)
getListing(uint256 nodeId) view returns (uint256,address,bool)
getRental(uint256 rentalId) view returns (uint256,uint256,uint8,address,address,uint256,uint256,uint8,uint256,uint256,uint256,uint256)
activeRentalForNode(uint256 nodeId) view returns (bool,uint256)
rent(uint256 nodeId,uint8 planId) nonpayable returns (uint256 rentalId)
startRental(uint256 rentalId)
cancelExpiredReservation(uint256 rentalId)
settleAfterExpiry(uint256 rentalId)
```

`nodeIsRented` and `getActiveRentalForNode` are forbidden production ABI entries. A TypeScript ergonomic helper may use either spelling only if it calls `activeRentalForNode`; no fallback selector is allowed.

Exact tuple layouts:

```text
getPlan:              (planId:uint8, durationSeconds:uint256, priceAtomic:uint256, active:bool, demoOnly:bool)
getNode:              (nodeId:uint256, provider:address, name:bytes32, active:bool)
getListing:           (nodeId:uint256, paymentToken:address, active:bool)
getRental:            (rentalId:uint256, nodeId:uint256, planId:uint8, renter:address, provider:address,
                       priceAtomic:uint256, durationSeconds:uint256, status:uint8, startDeadline:uint256,
                       startsAt:uint256, expiresAt:uint256, createdAt:uint256)
activeRentalForNode:  (hasRental:bool, rentalId:uint256)
```

Status enum: `NONE=0`, `RESERVED=1`, `ACTIVE=2`, `COMPLETED=3`, `CANCELLED=4`. Occupancy returns `(false,0)` when idle/terminal and `(true,id)` for RESERVED/ACTIVE. `getListing(1)` returns the fixed USDG `paymentToken` and is active exactly when `getNode(1).active` and no non-terminal rental exists. It has no price field: price/duration come from `getPlan(planId)`.

Required events: `RentalReserved`, `RentalStarted`, `RentalCancelled`, `RentalSettled`. Reservation event identifies rental/node/plan/renter/provider/atomic price/duration/deadline.

## 3. Contract lifecycle and payment

- `rent(nodeId,planId)` is nonpayable. Require a valid active node, active known plan, and no RESERVED/ACTIVE rental; snapshot `ownerOf(nodeId)` as provider and plan price/duration; execute exactly one USDG `transferFrom`; reject revert/false return; create RESERVED with deadline `createdAt+120`. Never accept ETH as rent.
- Only the snapshotted provider may `startRental` while RESERVED and `now < startDeadline`; set `startsAt=now`, `expiresAt=startsAt+durationSnapshot`, ACTIVE.
- At `now >= startDeadline`, anyone may cancel a still-RESERVED rental; close state before external transfer and refund exactly `priceAtomic` USDG to renter.
- At `now >= expiresAt`, anyone may settle ACTIVE; close state before external transfer and pay exactly `priceAtomic` USDG to frozen provider.
- Transfers are atomic/reentrancy protected. Failed transfer reverts all state. No early/duplicate terminal operation. Terminal states release occupancy.

## 4. Normalized chain boundary and Web payment reads

`packages/chain` owns ABI-backed calls, selector/calldata encoding, every positional decoder, normalized objects, USDG balance/allowance/approval helpers, and receipt interpretation. Application consumers never independently decode tuple positions.

```ts
type ChainPlan = { planId: number; durationSeconds: bigint; priceAtomic: bigint; active: boolean; demoOnly: boolean }
type ChainNode = { nodeId: bigint; provider: Address; name: string; active: boolean }
type ChainListing = { nodeId: bigint; paymentToken: Address; active: boolean }
type ChainRental = { rentalId: bigint; nodeId: bigint; planId: number; renter: Address; provider: Address;
  priceAtomic: bigint; durationSeconds: bigint; status: RentalStatus; startDeadline: bigint;
  startsAt: bigint; expiresAt: bigint; createdAt: bigint }
type ActiveRentalResult = ChainRental | null
```

Helper `getActiveRentalForNode(1)` calls ABI selector `activeRentalForNode(1)`, decodes the pair, returns null if false, otherwise fetches and validates matching Node ID and RESERVED/ACTIVE status. Unknown IDs, malformed data, or linked-contract/RPC failures fail closed. `PaymentTokenMetadata` must include address/symbol/decimals; live deployment gate requires six decimals. JSON bigint values are decimal strings.

Renter eligibility: normalized active Node 1 AND active listing AND null active-rental helper AND selected plan active. Immediately before approval/rent re-read relevant values, USDG balance/allowance, and plan. Approve exact plan amount by default; wait for mined successful approval and reread allowance. Submit only `rent(1,planId)` with no ETH value; success requires mined successful receipt plus fresh chain read.

## 5. Provider signer / start preflight

At reservation `rental.provider` is the `ownerOf(nodeId)` snapshot taken by the contract. Before signing, require `signer.address == rental.provider`, chain 46630, Node 1, current RESERVED rental, `now < startDeadline`, signer able to sign, RPC/decode healthy, Agent and explicit demo backend ready, and simulation/preflight success. After submission require successful mined receipt and reread ACTIVE. No specific signer vendor is mandated; secrets never enter repository, Web, logs, health, screenshots, or reports. Physical GPU is not a start precondition.

## 6. Agent HTTP v1

Shared rules: JSON error shape exactly `{ "error": string, "code": string }`; reject malformed/non-object JSON and unknown request keys as 400 `INVALID_BODY`; safe stable errors only. Unsafe-size integers are decimal strings. Agent never reveals RPC credentials, signer data, tunnel credentials, or backend URL.

### `GET /config`

200 exact public shape:

```json
{"chainId":46630,"nodeId":"1","computeAsset":"0x...","rentalManager":"0x...","paymentToken":"0x7E955252E15c84f5768B83c41a71F9eba181802F","paymentSymbol":"USDG","agentAudience":"https://private-agent-origin.example","interfaceVersion":"0.5","inferenceMode":"demo"}
```

No RPC URL/credential, explorer URL, signer identity/secret, backend URL/model, or tunnel credential. Web gets credential-free RPC config separately. Missing deployment config fails startup or returns 503 `CONFIG_UNAVAILABLE`; no partial config.

### `GET /health`

200 only for `status:"ok"`; otherwise 503 `status:"degraded"`. Required local demo checks: `agent`, `rpc`, `backend`; `privateRoute` can remain `unknown` from Agent perspective and is separately proven from renter side for DEMO-READY. `gpu` is optional and may be unknown. Exact keys:

```json
{"status":"ok|degraded","checks":[{"name":"agent","status":"ok|degraded|unhealthy|unknown"},{"name":"rpc","status":"ok|degraded|unhealthy|unknown"},{"name":"privateRoute","status":"ok|degraded|unhealthy|unknown"},{"name":"backend","status":"ok|degraded|unhealthy|unknown"},{"name":"gpu","status":"ok|degraded|unhealthy|unknown"}]}
```

No details, URLs, exceptions, rental identity/times, credentials, tokens, prompts, or outputs. Web treats every non-2xx as degraded regardless of body.

### `GET /node`

200 exact normalized display shape `{"nodeId":"1","provider":"0x<40 hex>","name":"","active":true}` (false/zero address when unavailable/inactive). Not rent authority. RPC/decode failure: 503 `RPC_UNAVAILABLE`.

### `GET /gpu/status`

Demo mode exact safe semantic shape: `{"mode":"demo","hardware":null,"backend":"demo-inference","ready":true}`. No fabricated hardware. Future hardware mode is a separately specified product/runtime mode, not P0.

### `POST /auth/challenge`

Request exactly `{"rentalId":"<positive decimal>"}`. Success 201 returns exact EIP-712 payload `{domain,types,primaryType,message}`; Web signs it unchanged, with no reconstruction. Domain: `ComputeRWA Agent Auth`, version `1`, chain `46630`, verifying RentalManager. Typed message `ComputeRWAAgentAuth(address renter,uint256 rentalId,uint256 nodeId,bytes32 nonce,uint64 issuedAt,uint64 expiresAt,string agentAudience)` and JSON integers are decimal strings. Challenge `expiresAt=min(issuedAt+60,rental.expiresAt)` and means challenge expiry. Require current ACTIVE rental owned by signer EOA before issuing. Errors: 400 `INVALID_BODY`; 404 `RENTAL_NOT_FOUND`; 409 `RENTAL_NOT_ACTIVE|RENTAL_EXPIRED|EOA_REQUIRED`; 503 `RPC_UNAVAILABLE|DEPENDENCY_UNAVAILABLE`.

### `POST /auth/verify`

Request exactly `{"signature":"0x<signature hex>","nonce":"0x<32-byte hex>","rentalId":"<positive decimal>"}`; no caller renter field. Success 201 exactly `{"token":"<opaque>","rentalId":"<decimal>","expiresAt":"<decimal Unix seconds>"}`. Expiry is authoritative rental expiry; server stores token digest only; Web memory only; Agent restart invalidates sessions. Errors: 400 `INVALID_BODY`; 401 `INVALID_SIGNATURE`; 404 `CHALLENGE_NOT_FOUND|RENTAL_NOT_FOUND`; 408 `CHALLENGE_EXPIRED`; 409 `CHALLENGE_REPLAYED|CHALLENGE_MISMATCH|RENTAL_NOT_ACTIVE|RENTAL_EXPIRED|RENTER_MISMATCH|NODE_MISMATCH|AUDIENCE_MISMATCH`; 503 `RPC_UNAVAILABLE|DEPENDENCY_UNAVAILABLE`.

### `POST /v1/inference`

Request exactly `{"prompt":"<non-empty text>"}`, `Authorization: Bearer <token>`. Reject additional model/backend/options fields. Revalidate chain 46630, current ACTIVE rental, renter/node/rental binding and `now < rental.expiresAt` every request; enforce quotas/concurrency. Errors before headers: 401 `INVALID_SESSION`, 409 stable rental/session state, 503 `RPC_UNAVAILABLE|DEPENDENCY_UNAVAILABLE`, 400 `INVALID_BODY`. Success is only `200 text/event-stream` with `delta`, then exactly one terminal `complete` or `error`; `complete` carries `{output,model:"archcore-demo-simulated",latencyMs}`; `delta` carries `{output}`; `error` carries `{code,error}`. Limits: 16 KiB JSON, 8 KiB UTF-8 prompt, bounded 256-token-equivalent demo output, 10 requests/rental, concurrency 1, 30s ceiling, 2s spacing. Abort propagates on cancel, disconnect, teardown, timeout and expiry; never emit false complete after abort/expiry.

## 7. Auth/session/private route

EIP-712 fields are `renter,rentalId,nodeId,nonce,issuedAt,expiresAt,agentAudience`. Session is opaque, memory-only, not logged/URL/cookie/storage, bound to renter/rental/node/audience, expires at authoritative rental expiry, and never bypasses fresh chain checks. Web clears on disconnect/account/chain/rental changes, expiry, teardown/navigation, Agent 401/409. No refresh token.

Only network tunnel is Browser→Provider Agent through real private operator-configured OmniRoute. Agent→Demo Backend is local Agent-owned runtime; do not assume OmniRoute. Unknown operator route facts remain UNKNOWN/BLOCKED. No Tailscale, Ollama, public backend, or physical GPU requirement.

## 8. Evidence/readiness

Use the readiness definitions in PRD §§18 and 28, repeated by coordination README and runbook. Fakes prove only their test layer. Local code gates, USDG decimal preflight, deployed wallet/contract lifecycle, private OmniRoute, and DEMO-READY evidence are separate. Never report unrun, unavailable, failed, or blocked evidence as PASS.
