# ARCHcore P0 Product Requirements

**Version:** 0.5  
**Status:** Active product requirements  
**Language:** English  
**Product:** ARCHcore  
**Target:** Arbitrum Open House Buildathon / Robinhood Chain Testnet  
**Supersedes:** `ARCHcore_PRD_P0_v0.4.md` and earlier P0 product decisions.

> **Document authority.** This PRD is the product authority. `INTERFACE_CONTRACTS.md` is the exact cross-role interface authority. Coordination/ownership documents define execution ownership. `INTEGRATION_RUNBOOK.md` defines merge, validation, deployment, and readiness procedures. Role prompts are subordinate execution instructions. Source code, generated artifacts, checkpoints, handoffs, and build reports are implementation evidence, not alternate product requirements.

---

## 1. Executive summary

ARCHcore is an RWA-inspired compute-rental protocol that turns temporary access to provider-owned offchain compute into an onchain, time-bounded economic right.

The real-world resource stays offchain. ARCHcore does **not** claim that an NFT transfers legal ownership of a GPU or proves hardware execution. Instead:

- `ComputeAsset` gives the provider-owned compute node an onchain identity;
- `RentalManager` escrows USDG and records who has the right to use that node, for which plan, and for how long;
- `Provider Agent` enforces the active onchain lease before issuing a session and before every inference request;
- the renter reaches the Provider Agent through a real operator-configured private OmniRoute route;
- P0 inference computation is intentionally provided by an explicit **Demo Inference Backend**, not a physical GPU;
- USDG is the rental/escrow denomination; native testnet ETH is used only for gas.

The P0 product catalog begins at a real six-hour rental. A special five-minute **Testnet Demo** plan exists only to compress the lifecycle so expiry, access denial, refund, and settlement can be demonstrated during the Buildathon.

---

## 2. Product thesis and RWA framing

### 2.1 Problem

Idle or under-utilized compute exists outside large cloud providers, while developers and AI users may need temporary access to inference capacity. Renting compute from an independent provider introduces several trust problems:

- who is allowed to use the resource;
- when that right starts and ends;
- whether payment is actually escrowed;
- whether the provider can redirect payout after booking;
- what happens if the provider never starts the rental;
- what happens when the rental expires;
- whether access enforcement follows the same state as settlement.

ARCHcore moves the **economic lease state** onchain while keeping the physical resource and execution layer offchain.

### 2.2 What the RWA is

ARCHcore's RWA primitive is the economic usage right associated with a provider-declared offchain compute resource.

```text
Physical/offchain compute resource
        ↓ represented by identity
ComputeAsset
        ↓ rentable usage right
RentalManager lease
        ↓ enforced offchain
Provider Agent
```

`ComputeAsset` is an onchain identity and provider relationship for a compute node. It is **not** legal title to a GPU and is **not** cryptographic proof that a specific GPU executed a request.

### 2.3 North-star statement

> ARCHcore makes access to offchain compute rentable as an onchain, USDG-settled, time-bounded right whose authorization and economic settlement follow the same authoritative lease state.

---

## 3. P0 goals

P0 must prove, end to end, that:

1. a renter can select Node 1 and a valid rental plan;
2. the renter can approve and escrow the exact USDG plan price;
3. the provider is snapshotted at reservation time;
4. the provider-controlled Agent starts the rental only while valid and ready;
5. the chain records an exact `startsAt` and plan-derived `expiresAt`;
6. the renter authenticates to the Agent with EIP-712;
7. the Agent re-validates the authoritative lease before every inference request;
8. the renter accesses the Agent through a real private OmniRoute route;
9. the explicit Demo Inference Backend streams bounded simulated/local output;
10. access stops when the lease expires;
11. a missed provider start can be refunded 100% to the renter;
12. an expired active rental can be settled 100% to the frozen provider;
13. all live claims are backed by reproducible sanitized evidence.

---

## 4. P0 non-goals

P0 does **not** include:

- multiple provider discovery or an open marketplace registry;
- reputation or staking;
- auctions;
- dynamic provider-defined pricing;
- user-defined rental duration;
- prorated refunds;
- pay-as-you-go or per-token billing;
- early termination credits;
- uptime-adjusted billing or SLA compensation;
- smart-wallet/EIP-1271 renter authentication;
- permit/Permit2 as a required payment path;
- confidential compute claims;
- hardware attestation;
- proof that a physical GPU executed inference;
- arbitrary code execution;
- SSH, shell, filesystem, Docker, CUDA, or OS access for renters;
- distributed inference;
- direct public inference-backend exposure;
- automatic tunnel provisioning;
- automatic fallback from a real backend to the demo backend;
- Ollama or Tailscale as required architecture.

---

## 5. Frozen network and payment facts

| Requirement | P0 value |
| --- | --- |
| Network | Robinhood Chain Testnet |
| Chain ID | `46630` |
| Smart-contract stack | Arbitrum Stylus / Rust |
| Native gas token | Testnet ETH |
| Rental payment token | USDG on Robinhood Testnet |
| USDG address | `0x7E955252E15c84f5768B83c41a71F9eba181802F` |
| Payment mechanism | ERC-20 `approve` + `transferFrom` escrow |
| Compute node | Node ID `1` |
| Provider count | One P0 provider identity |
| Renter identity | One EOA per rental |
| Start grace | `120` seconds from reservation |
| Occupancy | One non-terminal rental for Node 1 |
| Inference concurrency | One generation at a time |
| Renter-to-Agent transport | Operator-configured private OmniRoute route |
| Inference execution | Explicit Demo Inference Backend |

### 5.1 USDG decimal preflight

P0 pricing is defined in human-readable USDG and in atomic units assuming six decimals. Before deployment is accepted, the Integrator/ABI role must read the actual token contract on chain and require:

```text
decimals() == 6
```

If the deployed token reports any other value, deployment is `BLOCKED` until this PRD/interface ledger is deliberately revised. Do not silently rescale prices.

Native testnet ETH remains required by renter/provider/operator wallets for gas but is never rental escrow.

---

## 6. Rental economics

### 6.1 Economics principles

- ARCHcore sells **time-bounded access**, not tokens/prompts.
- The renter pays the selected plan price upfront into contract escrow.
- Time starts only after the provider successfully starts the rental.
- If the provider misses the start deadline, the renter receives a full refund.
- If the renter stops using the node early, P0 provides no prorated refund.
- An active rental reserves Node 1 against any second non-terminal rental.
- After expiry, settlement pays 100% of the frozen escrow to the frozen provider.
- The longer the standard plan, the lower the effective hourly rate.

### 6.2 Base commercial rate

The frozen P0 product-rate anchor is:

```text
BASE_HOURLY_RATE = 1.00 USDG/hour
```

This is a product/demo economic constant for the current Buildathon release. It is not a claim about market-clearing GPU pricing.

### 6.3 Frozen plan catalog

USDG uses six atomic decimals for P0 after successful deployment preflight.

| Plan ID | Name | Duration | Seconds | Discount vs 1 USDG/h | Price USDG | Price atomic | Scope |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `0` | Testnet Demo | 5 min | `300` | n/a | `0.10` | `100000` | Testnet lifecycle demonstration only |
| `1` | 6 Hours | 6 h | `21600` | `0%` | `6.00` | `6000000` | Standard commercial plan |
| `2` | 12 Hours | 12 h | `43200` | `5%` | `11.40` | `11400000` | Standard commercial plan |
| `3` | 24 Hours | 24 h | `86400` | `10%` | `21.60` | `21600000` | Standard commercial plan |
| `4` | 7 Days | 168 h | `604800` | `15%` | `142.80` | `142800000` | Standard commercial plan |
| `5` | 14 Days | 336 h | `1209600` | `20%` | `268.80` | `268800000` | Standard commercial plan |
| `6` | 30 Days | 720 h | `2592000` | `30%` | `504.00` | `504000000` | Standard commercial plan |

Plan `0` must be visually labeled **TESTNET DEMO**. It is not the minimum commercial product. The actual commercial catalog starts at Plan `1` / six hours.

P0 intentionally omits 18-hour and 21-day default plans to keep the catalog comprehensible. Future product versions may add plans only through a deliberate contract/product revision.

### 6.4 Price and duration immutability

For P0, all seven plans are contract-defined constants. There is:

- no plan setter;
- no provider price setter;
- no frontend-controlled duration;
- no environment override;
- no constructor override that changes plan economics;
- no hidden backend discount.

A rental snapshots `planId`, `priceAtomic`, and `durationSeconds` at reservation. Later product versions cannot retroactively change an existing rental.

---

## 7. End-to-end renter journey

### 7.1 Discover and quote

1. Renter opens the Web app.
2. Web connects an EOA and verifies/switches to chain `46630`.
3. Web reads normalized Node 1 state from `packages/chain`.
4. Web reads the frozen plan catalog from the chain.
5. Web verifies Node 1 is active, its listing is active, and no non-terminal rental exists.
6. Web displays USDG balance, required price, effective hourly rate, plan duration, and ETH-for-gas status.

### 7.2 Approve and reserve

1. Renter selects a plan.
2. Web immediately re-reads node/listing/occupancy/plan data.
3. Web checks exact USDG balance and allowance.
4. If allowance is below the exact plan price, Web requests an ERC-20 approval for the exact required amount.
5. Web waits for a successful mined approval receipt and re-reads allowance.
6. Web sends `rent(nodeId, planId)`.
7. `RentalManager` transfers the exact plan amount from renter into escrow.
8. Contract snapshots renter, provider, plan, amount, duration, and start deadline.
9. Status becomes `RESERVED`.
10. Web reports success only after the rental transaction receipt succeeds and chain state is re-read.

### 7.3 Provider start

1. Provider Agent observes the reservation.
2. Agent checks current chain/rental state, signer identity, RPC readiness, OmniRoute configuration state, and Demo Inference Backend readiness.
3. Agent ensures its signer address equals the rental's frozen provider.
4. Before deadline, Agent simulates and submits `startRental(rentalId)`.
5. After a successful receipt, Agent re-reads the rental.
6. Contract sets:

```text
startsAt = block.timestamp
expiresAt = startsAt + durationSecondsSnapshot
status = ACTIVE
```

### 7.4 Authenticate and infer

1. Web requests an EIP-712 challenge.
2. Agent confirms rental is currently ACTIVE and belongs to the connected renter.
3. Renter signs the exact typed data returned by Agent.
4. Agent verifies signature, audience, nonce, renter, rental, node, challenge lifetime, and current chain state.
5. Agent returns an opaque memory-only session token.
6. Web sends inference through the private OmniRoute Browser→Agent route.
7. Before each inference, Agent re-checks the authoritative chain rental.
8. Agent invokes the explicit Demo Inference Backend.
9. Agent streams `delta`, then one terminal `complete` or `error` event.

### 7.5 Expiry and settlement

At `now >= expiresAt`:

- no new inference may start;
- active generation must be aborted;
- the session cannot bypass expiry;
- anyone may call `settleAfterExpiry(rentalId)`;
- contract closes occupancy/escrow before external token transfer;
- 100% of escrow is paid in USDG to the frozen provider;
- status becomes `COMPLETED`;
- Node 1 becomes rentable again.

### 7.6 Missed provider start

At `now >= startDeadline` while still `RESERVED`:

- anyone may call `cancelExpiredReservation(rentalId)`;
- occupancy/escrow is closed before token transfer;
- 100% of escrow is refunded in USDG to renter;
- status becomes `CANCELLED`;
- Node 1 becomes rentable again.

---

## 8. System architecture

```text
                         Robinhood Chain Testnet (46630)
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
              ComputeAsset                RentalManager
             Node identity          USDG escrow + lease state
                    │                           │
                    └─────────────┬─────────────┘
                                  │ authoritative state
                    ┌─────────────┴─────────────┐
                    │                           │
               Renter Web                Provider Agent
                    │                           │
                    │ private OmniRoute         │
                    └──────────────────────────►│
                                                │ auth + guard
                                                ▼
                                      Demo Inference Backend
                                                │
                                                ▼
                                     simulated/local text output
```

### 8.1 Trust boundaries

- Chain is authority for node identity, provider snapshot, renter, plan snapshot, escrow, lifecycle, start deadline, start time, expiry, and terminal state.
- Provider Agent is the only application authorization boundary for inference.
- OmniRoute is the renter-to-Agent private transport, not rental authority.
- Demo Inference Backend has no authority to decide who may infer.
- Web state, Agent caches, events, logs, and databases are not rental authority.

---

## 9. ComputeAsset contract requirements

`ComputeAsset` represents the provider-declared offchain compute node.

Required properties:

- only authorized enrollment/minting;
- unique Node ID;
- Node `1` is the only enrolled P0 demo node;
- soulbound: every ERC-721 transfer path is blocked;
- approvals/operators cannot bypass soulbound semantics;
- retirement/burn is irreversible;
- retired IDs cannot be reused;
- `ownerOf(uint256)` exposes the live provider identity;
- `isActive(uint256)` is derived exactly as:

```text
nodeExists(nodeId) && !isRetired(nodeId)
```

- unknown, burned, and retired nodes are inactive;
- no duplicate provider ownership storage may be added simply for RentalManager;
- ERC-165/interface claims must match actual behavior.

`ComputeAsset` does not claim legal ownership of physical hardware.

---

## 10. RentalManager contract requirements

### 10.1 Frozen production ABI

The target P0 production ABI is:

```text
paymentToken() view returns (address)
planCount() view returns (uint8)
getPlan(uint8 planId)
getNode(uint256 nodeId)
getListing(uint256 nodeId)
getRental(uint256 rentalId)
activeRentalForNode(uint256 nodeId) returns (bool hasRental, uint256 rentalId)
rent(uint256 nodeId, uint8 planId) returns (uint256 rentalId)
startRental(uint256 rentalId)
cancelExpiredReservation(uint256 rentalId)
settleAfterExpiry(uint256 rentalId)
```

`rent` is **nonpayable**. Native ETH is not accepted as rental payment.

### 10.2 Payment token

`paymentToken()` must equal the frozen Robinhood Testnet USDG address:

```text
0x7E955252E15c84f5768B83c41a71F9eba181802F
```

There is no P0 payment-token setter.

### 10.3 Plan getter

`getPlan(uint8 planId)` returns, in exact order:

```text
planId,
durationSeconds,
priceAtomic,
active,
demoOnly
```

Types:

```text
uint8,
uint256,
uint256,
bool,
bool
```

`planCount()` returns `7`.

Unknown plan IDs are invalid and cannot be rented.

### 10.4 Node and listing getters

`getNode(uint256 nodeId)` returns exactly:

```text
nodeId,
provider,
name,
active
```

with types:

```text
uint256,
address,
bytes32,
bool
```

`getListing(uint256 nodeId)` returns exactly:

```text
nodeId,
paymentToken,
active
```

with types:

```text
uint256,
address,
bool
```

Listing activity is derived from a valid active node and the absence of an existing non-terminal rental. There is no listing storage, listing CRUD, manual activation, or listing-price field because pricing comes from the selected plan.

### 10.5 Occupancy selector

The only production occupancy selector is:

```text
activeRentalForNode(uint256 nodeId)
    returns (bool hasRental, uint256 rentalId)
```

There is no production `nodeIsRented` or `getActiveRentalForNode` selector. TypeScript may expose ergonomic helper names only when the actual ABI call is `activeRentalForNode`.

### 10.6 Rental tuple

`getRental(uint256 rentalId)` returns exactly, in order:

```text
rentalId,
nodeId,
planId,
renter,
provider,
priceAtomic,
durationSeconds,
status,
startDeadline,
startsAt,
expiresAt,
createdAt
```

Recommended Solidity ABI-equivalent types:

```text
uint256,
uint256,
uint8,
address,
address,
uint256,
uint256,
uint8,
uint256,
uint256,
uint256,
uint256
```

Status values:

```text
NONE      = 0
RESERVED  = 1
ACTIVE    = 2
COMPLETED = 3
CANCELLED = 4
```

### 10.7 `rent`

`rent(nodeId, planId)` must:

1. reject any unknown/inactive node;
2. reject inactive/unknown plan;
3. reject a node with any `RESERVED` or `ACTIVE` rental;
4. read and snapshot `ownerOf(nodeId)` as provider;
5. snapshot plan price and duration;
6. require exact USDG balance/allowance indirectly through successful token transfer;
7. execute exactly one USDG `transferFrom(renter, RentalManager, priceAtomic)`;
8. reject failed/false-return token transfers;
9. create exactly one `RESERVED` rental;
10. set `startDeadline = createdAt + 120`;
11. mark Node 1 occupied atomically;
12. never accept native ETH.

Use reentrancy protection. Any external-call failure reverts the full operation.

### 10.8 `startRental`

`startRental(rentalId)`:

- only frozen `provider` may call;
- only `RESERVED` rental may start;
- requires `now < startDeadline`;
- sets `startsAt = now`;
- sets `expiresAt = startsAt + durationSecondsSnapshot`;
- sets status `ACTIVE`;
- does not transfer escrow.

### 10.9 Refund

`cancelExpiredReservation(rentalId)`:

- permissionless at `now >= startDeadline`;
- only for still-`RESERVED` rental;
- closes occupancy and escrow accounting before external transfer;
- sends exactly `priceAtomic` USDG to renter;
- becomes `CANCELLED`;
- reverts atomically if token transfer fails;
- cannot execute twice.

### 10.10 Settlement

`settleAfterExpiry(rentalId)`:

- permissionless at `now >= expiresAt`;
- only for `ACTIVE` rental;
- closes occupancy and escrow accounting before external transfer;
- sends exactly `priceAtomic` USDG to frozen provider;
- becomes `COMPLETED`;
- reverts atomically if token transfer fails;
- cannot execute early or twice.

### 10.11 Required events

At minimum emit events sufficient to reconstruct:

```text
RentalReserved
RentalStarted
RentalCancelled
RentalSettled
```

`RentalReserved` must expose enough indexed/non-indexed data to identify `rentalId`, `nodeId`, `planId`, renter, provider, price, duration, and start deadline without trusting frontend state.

---

## 11. ABI and chain package

`packages/abi` and `packages/chain` are the only shared production interpretation layer between contracts and TypeScript applications.

Requirements:

- production ABI JSON must be generated from final contract source using documented Stylus ABI export;
- never hand-edit ABI JSON;
- export must be deterministic and byte-stable on repeated runs;
- conformance tests must validate exact selector names, mutability, inputs, outputs, tuple ordering, and events;
- reject stale native-ETH `payable rent(uint256)` ABI after USDG migration;
- reject stale `nodeIsRented` production selector;
- `packages/chain` owns all raw tuple decoding;
- Web and Agent consume normalized objects, not independent positional decoders;
- `packages/chain` owns USDG `balanceOf`, `allowance`, and approval-read helpers used by Web;
- chain package must distinguish transaction hash submission from successful mined receipt;
- all bigint quantities cross JSON boundaries as decimal strings.

Normalized types should include at least:

```text
ChainNode
ChainListing
ChainPlan
ChainRental
ActiveRentalResult
PaymentTokenMetadata
```

---

## 12. Provider Agent

### 12.1 Role

Provider Agent runs on the provider-controlled device and is the bridge between onchain lease state and offchain service access.

It binds to loopback by default and is reachable by the renter only through the configured private OmniRoute route.

### 12.2 Reservation watcher and provider signer

Agent observes Node 1 reservations and may call `startRental` only after all required preconditions are true.

Provider transaction signer must satisfy:

```text
signer.address == rental.provider
```

Before attempting start, Agent must require:

- chain ID `46630`;
- current rental status `RESERVED`;
- current `now < startDeadline`;
- signer available and capable of signing;
- signer matches frozen provider;
- RPC available and ABI decodable;
- Agent healthy;
- Demo Inference Backend healthy;
- required OmniRoute configuration present for live-demo readiness;
- transaction simulation/preflight succeeds.

After transaction submission, Agent requires a successful mined receipt and re-reads the rental as `ACTIVE`.

Transient failures may retry safely with bounded backoff while the reservation remains eligible. Stop on terminal state or expired deadline.

### 12.3 Demo Inference Backend

P0 runtime mode is explicitly:

```text
INFERENCE_BACKEND_MODE=demo
```

No silent fallback exists.

The Demo Inference Backend is a runnable runtime component, not a unit-test fake. It must:

- accept only requests invoked by Provider Agent;
- accept prompt input;
- stream bounded incremental output;
- support cancellation/AbortSignal semantics;
- support timeout;
- expose health/readiness to Agent;
- allow deterministic error paths for validation;
- identify itself as demo/simulated;
- never claim physical GPU execution.

Physical GPU, CUDA, `nvidia-smi`, VRAM, temperature, and real local model execution are not P0 demo requirements.

### 12.4 HTTP surface

Provider Agent exposes:

```text
GET  /config
GET  /health
GET  /node
GET  /gpu/status
POST /auth/challenge
POST /auth/verify
POST /v1/inference
```

Exact schemas are frozen in the interface ledger. The PRD-level minimums are below.

#### `GET /config`

Public, non-secret configuration only:

```json
{
  "chainId": 46630,
  "nodeId": "1",
  "computeAsset": "0x...",
  "rentalManager": "0x...",
  "paymentToken": "0x7E955252E15c84f5768B83c41a71F9eba181802F",
  "paymentSymbol": "USDG",
  "agentAudience": "https://private-agent-origin.example",
  "interfaceVersion": "0.5",
  "inferenceMode": "demo"
}
```

Do not expose RPC credentials, provider signer secrets, backend secrets, or tunnel credentials.

#### `GET /health`

Must distinguish at least:

- Agent process;
- chain/RPC;
- OmniRoute configuration/reachability state;
- Demo Inference Backend.

Any non-2xx response means degraded/unready regardless of body.

#### `GET /node`

Normalized safe Node 1 summary suitable for UI presentation. It is not a substitute for authoritative chain reads used to enable transactions.

#### `GET /gpu/status`

Because P0 intentionally uses demo inference, no fake hardware data may be invented. Canonical semantics are equivalent to:

```json
{
  "mode": "demo",
  "hardware": null,
  "backend": "demo-inference",
  "ready": true
}
```

Any future real-hardware mode must be a separate explicit product/runtime mode.

### 12.5 EIP-712 auth

Domain:

```text
name: ComputeRWA Agent Auth
version: 1
chainId: 46630
verifyingContract: RentalManager
```

Message binds:

```text
renter
rentalId
nodeId
nonce
issuedAt
expiresAt
agentAudience
```

Nonce requirements:

- cryptographically random;
- single use;
- 60-second maximum TTL;
- replay rejected.

Challenge expiry:

```text
expiresAt = min(issuedAt + 60 seconds, rental.expiresAt)
```

If the resulting lifetime is non-positive, no challenge is issued.

### 12.6 Session

Successful verification returns an opaque session token.

Requirements:

- memory-only in Web;
- never localStorage/sessionStorage/cookie/URL;
- never logged;
- bound to renter, rental, node, and Agent audience;
- P0 session expiry equals authoritative rental expiry;
- Agent restart invalidates memory-only sessions;
- token validity never bypasses a fresh chain check before inference.

### 12.7 Inference guard

Before every inference request, Agent must require:

- valid bearer session;
- current chain ID is `46630`;
- current rental exists;
- rental renter equals session renter;
- rental node equals Node 1;
- status is `ACTIVE`;
- `now < rental.expiresAt`;
- request quota available;
- global/rental concurrency available.

Fail closed on RPC or decode errors.

### 12.8 Limits

Default P0 limits:

| Limit | Value |
| --- | ---: |
| JSON body | 16 KiB |
| Prompt | 8 KiB |
| Output | 256 tokens-equivalent/bounded demo output |
| Requests per rental | 10 |
| Concurrent inference | 1 |
| Generation ceiling | 30 seconds |
| Minimum spacing | 2 seconds |
| Challenge TTL | 60 seconds |

### 12.9 SSE

Only these events exist:

```text
event: delta
event: complete
event: error
```

Abort must propagate from:

- explicit renter cancel;
- browser disconnect;
- page teardown;
- generation timeout;
- onchain rental expiry.

After abort/expiry, Agent must not emit a false `complete` event.

---

## 13. OmniRoute private transport

The final P0 demo requires a real operator-configured private OmniRoute path:

```text
Renter browser
    ↓
private OmniRoute route
    ↓
Provider Agent
```

OmniRoute is **not** mocked for final `DEMO-READY`.

The PRD does not invent:

- hostname;
- public URL;
- route command;
- auth scheme;
- tunnel port;
- TLS implementation detail.

Role 5 must record the actual sanitized operator configuration. Unknown facts remain `UNKNOWN` and dependent live gates remain `BLOCKED`.

Agent→Demo Inference Backend is an internal runtime interface and is not assumed to traverse OmniRoute.

---

## 14. Renter Web

### 14.1 Product surfaces

P0 Web should present four primary states/screens:

1. **Node / Rental Marketplace** — Node 1 identity, provider, chain, USDG, availability, plan catalog.
2. **Checkout / Rental** — selected plan, USDG balance, allowance, approval, rent transaction, exact quote.
3. **Active Rental** — rental status, countdown, renter/provider, plan, escrow amount, explorer links, auth/inference access.
4. **Inference Console** — authenticated prompt and streaming output with explicit `Demo Inference` badge.

A lifecycle/history area may show the current rental and terminal transaction evidence; a full marketplace/history product is out of scope.

### 14.2 Plan presentation

UI must clearly separate:

```text
TESTNET DEMO
5 minutes — 0.10 USDG
```

from:

```text
STANDARD RENTALS
6 Hours
12 Hours
24 Hours
7 Days
14 Days
30 Days
```

For each standard plan show:

- total USDG price;
- duration;
- effective hourly rate;
- discount vs 1 USDG/h where applicable.

The UI may compute display-only effective hourly rate/discount from chain values, but transaction price always comes from current chain plan data.

### 14.3 Eligibility

Before enabling rent, Web must consume normalized `packages/chain` results and require:

```text
getNode(1).active == true
getListing(1).active == true
active rental helper == null
selectedPlan.active == true
```

It must also show:

- USDG balance;
- USDG allowance;
- required price;
- whether renter has ETH for gas.

### 14.4 Approval flow

If allowance is insufficient:

1. enable `Approve USDG`;
2. request approval for the exact plan amount by default;
3. wait for successful mined receipt;
4. re-read allowance;
5. only then enable the final rent transaction.

Unlimited approval is not the default P0 UX.

### 14.5 Rent flow

Immediately before rent:

- re-read Node 1;
- re-read listing;
- re-read occupancy;
- re-read selected plan;
- re-read USDG balance/allowance.

Send only the canonical nonpayable `rent(1, planId)` call.

Never send native ETH as rental value.

A wallet returning a transaction hash is not success. Wait for successful mined receipt and then re-read rental state.

### 14.6 Active rental UI

Display chain-derived:

- rental ID;
- plan name/ID;
- renter;
- frozen provider;
- USDG escrow amount;
- `RESERVED`/`ACTIVE`/terminal status;
- start deadline;
- startsAt;
- expiresAt;
- live countdown using chain timestamp assumptions conservatively;
- explorer links.

When `RESERVED`, show provider-start waiting state and refund availability after deadline.

When `ACTIVE`, enable authentication/inference.

When expired, inference is disabled even before settlement is submitted.

### 14.7 Auth/session UI

Web signs exactly the typed data returned by Agent. It does not reconstruct EIP-712 fields independently.

Session token is held in memory only and cleared on:

- wallet disconnect;
- account change;
- chain change;
- selected rental change;
- rental expiry;
- navigation/page teardown where applicable;
- Agent 401/409;
- explicit logout/reset.

### 14.8 Inference UI

- Clearly badge output as `Demo Inference` / `Simulated Backend`.
- Use bearer authorization.
- Render all output as safe text, never raw HTML.
- Stream only canonical SSE events.
- Offer explicit Cancel.
- Abort on expiry/identity change/page teardown.
- Never reveal backend internal URL or credential.

---

## 15. Payment UX and economics presentation

The checkout must make the economic split obvious:

```text
Rental payment: USDG
Network gas: ETH
```

Example for Plan 1:

```text
6 Hours
Base: 6.00 USDG
Discount: 0%
Total escrow: 6.00 USDG
Gas: paid separately in testnet ETH
```

Example Plan 4:

```text
7 Days
Base equivalent: 168.00 USDG
Duration discount: 15%
Total escrow: 142.80 USDG
```

No frontend formula is authoritative. It must derive display values from frozen/current chain plan values.

---

## 16. Privacy and security

### 16.1 Secrets and sensitive content

Never expose or persist in Git, browser storage, logs, screenshots, analytics, or reports:

- private keys;
- provider signer secrets;
- credentialed RPC URLs;
- OmniRoute credentials;
- bearer tokens;
- EIP-712 signatures;
- nonces;
- prompts;
- model/demo output where logs are involved.

### 16.2 Network boundaries

- Agent binds loopback by default.
- Browser reaches Agent only through approved private OmniRoute route.
- Browser never gets direct Demo Backend access.
- No public inference/GPU port.

### 16.3 Authorization

- Chain is authority.
- Session is convenience, not authority.
- Every inference rechecks chain.
- Exact-origin CORS.
- Wrong renter/chain/node/rental fails closed.

### 16.4 Contract security

Required negative-path coverage includes:

- wrong plan;
- inactive node;
- double reservation;
- insufficient USDG balance;
- insufficient allowance;
- token transfer revert/false return;
- wrong provider start;
- early cancel;
- early settlement;
- duplicate refund;
- duplicate payout;
- reentrancy attempts;
- failed refund/payout transfer atomic rollback;
- stale occupancy cleanup after terminal state.

---

## 17. Error model

The system must distinguish errors instead of flattening them into generic success/failure.

Examples:

### Web/payment

- wrong network;
- wallet rejected;
- insufficient ETH gas;
- insufficient USDG balance;
- approval rejected;
- approval reverted;
- stale allowance;
- rent reverted;
- pending receipt;
- occupied node.

### Agent

- auth required;
- invalid/replayed challenge;
- wrong renter;
- wrong rental;
- expired challenge;
- non-ACTIVE rental;
- expired rental;
- RPC unavailable;
- OmniRoute/live-route unavailable;
- Demo Backend unavailable;
- quota exhausted;
- concurrency busy;
- generation timeout.

Unavailable dependencies use truthful degraded state; do not return a 200 body saying "unhealthy" and treat it as healthy.

---

## 18. Evidence and readiness vocabulary

### 18.1 Evidence separation

These are separate gates:

- Rust formatting;
- host contract tests;
- linked-contract compatibility;
- WASM release build;
- Stylus check;
- ABI export;
- ABI/source/client conformance;
- chain package tests/typecheck/build;
- Agent tests/typecheck/lint/build;
- Web tests/typecheck/build;
- security tests;
- USDG onchain metadata preflight;
- deployment;
- real wallet approval/rent;
- provider signer transaction;
- real OmniRoute route;
- authenticated inference;
- expiry abort;
- missed-start refund;
- settlement.

One gate never proves another.

### 18.2 NOT READY

Required local work or required gates remain incomplete.

### 18.3 CODE-READY

All required integrated local source/artifact/security gates pass, including USDG ABI/payment migration and the plan-based rental interface.

CODE-READY does not imply deployment, wallet, OmniRoute, or live E2E.

### 18.4 DEMO-READY

Requires all of:

- linked ComputeAsset/RentalManager deployed on Robinhood Chain Testnet `46630`;
- USDG token preflight passed;
- real renter EOA;
- real USDG approval and escrow transaction;
- real provider signer matching frozen provider;
- real Provider Agent;
- real private OmniRoute Browser→Agent route;
- explicit Demo Inference Backend runtime;
- real EIP-712 auth and replay/session enforcement;
- authenticated SSE inference;
- expiry denial/abort;
- missed-start 100% USDG refund;
- expired-active 100% USDG settlement;
- sanitized reproducible evidence.

Physical GPU, `nvidia-smi`, CUDA, GPU telemetry, and real local LLM execution are **not** P0 `DEMO-READY` requirements.

---

## 19. Buildathon demo acceptance

The final demo should deliberately show both the real commercial plan model and the compressed lifecycle plan.

### Demo A — Standard six-hour rental is real

Use Plan `1`:

```text
6 Hours
6.00 USDG
```

Demonstrate:

1. connected renter on chain 46630;
2. Node 1 available;
3. Plan 1 read from chain;
4. renter USDG balance;
5. exact 6 USDG approval;
6. `rent(1, 1)` mined successfully;
7. contract escrow = 6 USDG;
8. rental provider frozen;
9. Provider Agent starts it;
10. ACTIVE `expiresAt - startsAt == 21600`;
11. EIP-712 auth;
12. inference succeeds through OmniRoute/Agent/Demo Backend.

The demo does **not** wait six hours for this rental to expire.

### Demo B — Full compressed lifecycle

Use Plan `0`:

```text
Testnet Demo
5 minutes
0.10 USDG
```

Demonstrate:

1. approve + rent;
2. provider start;
3. ACTIVE;
4. authenticated inference;
5. expiry abort or denial;
6. post-expiry request rejected;
7. permissionless settlement;
8. provider receives exactly 0.10 USDG;
9. Node becomes rentable again.

### Demo C — Missed-start protection

Use a separate Plan `0` reservation:

1. renter escrows 0.10 USDG;
2. provider intentionally does not start;
3. after 120-second deadline, anyone calls cancel;
4. renter receives exactly 0.10 USDG back;
5. status is `CANCELLED`;
6. Node becomes rentable again.

### Demo D — Security denial

Show at least one:

- wrong wallet cannot authenticate;
- expired rental cannot infer;
- second rental while occupied reverts;
- stale/replayed auth challenge is rejected.

---

## 20. Buildathon positioning

ARCHcore should be presented as:

> **RWA infrastructure for rentable compute access.**

Not as:

- an NFT claiming legal GPU ownership;
- a generic AI chatbot;
- a centralized compute marketplace with blockchain added for decoration.

The Buildathon story is:

```text
Offchain compute resource
        ↓
Onchain ComputeAsset identity
        ↓
USDG-denominated time-bounded rental right
        ↓
Stylus escrow/lifecycle on Robinhood Chain
        ↓
Provider Agent enforces that right offchain
```

P0 demonstrates real Arbitrum/Robinhood transactions, Stylus contracts, USDG escrow, private networking, and authorization while intentionally simulating only the expensive model-computation layer.

---

## 21. Required repository components

```text
contracts/compute-asset
    ComputeAsset identity

contracts/rental-manager
    plan catalog
    USDG escrow
    rental lifecycle

packages/abi
    source-generated ABI artifacts

packages/chain
    normalized chain reads/writes
    USDG balance/allowance helpers
    receipt handling

apps/agent
    reservation watcher
    provider signer
    auth/session
    chain guard
    quota/concurrency
    SSE proxy
    Demo Inference Backend adapter

apps/web
    wallet/network
    plan catalog
    USDG approval/checkout
    rental lifecycle
    auth
    inference console

OmniRoute
    private Browser → Agent transport
```

---

## 22. Required implementation order

1. **Integrator / Role 5** updates interface ledger, runbook, `.env.example`, prompts, and mismatch register to this v0.5 authority.
2. **Contracts / Role 1** migrates RentalManager from native-ETH fixed rental to USDG + plan-based rental while preserving ComputeAsset semantics.
3. **ABI & Chain / Role 2** exports fresh ABI, proves deterministic artifacts, updates normalized plan/rental/payment helpers, and removes stale payable/native-ETH assumptions.
4. **Provider Agent / Role 3** aligns watcher/start preflight and HTTP/config/auth/runtime with the new rental tuple and USDG/plan semantics.
5. **Renter Web / Role 4** implements plan catalog, USDG approval + rent checkout, normalized chain consumption, active rental/inference flow.
6. **Integrator / Role 5** reruns all integrated local gates and may declare `CODE-READY` only with evidence.
7. Deploy to chain 46630, provision/fund wallets, configure OmniRoute, run live acceptance, then declare `DEMO-READY` only with reproducible evidence.

No role may silently patch another role's source to make its own gate green.

---

## 23. Configuration contract

Active environment guidance must use one naming scheme and must not expose secrets to Web.

Conceptual required configuration:

```text
# Public/non-secret build config
CHAIN_ID=46630
NODE_ID=1
USDG_ADDRESS=0x7E955252E15c84f5768B83c41a71F9eba181802F
COMPUTE_ASSET_ADDRESS=<deployed>
RENTAL_MANAGER_ADDRESS=<deployed>
INFERENCE_BACKEND_MODE=demo

# Provider/private runtime
RPC_URL=<operator RPC>
PROVIDER_SIGNER=<secure operator-supplied signer mechanism>
AGENT_AUDIENCE=<private OmniRoute HTTPS origin>
```

The exact secret-signing mechanism and OmniRoute fields are finalized by the interface ledger/operator integration contract. Secret values never enter repository docs.

No environment variable may change plan durations/prices in P0.

---

## 24. Testing requirements

### Contracts

Cover:

- ComputeAsset enrollment/retirement/soulbound behavior;
- all seven plan getters;
- invalid plan;
- exact plan snapshots;
- USDG transferFrom success/failure;
- insufficient allowance/balance behavior;
- no native-ETH rent path;
- occupancy;
- provider snapshot;
- start authorization/time boundary;
- duration-specific expiry;
- refund;
- settlement;
- re-rent;
- failed transfer rollback;
- reentrancy;
- duplicate terminal actions.

### ABI/Chain

Cover exact ABI, tuple orders, atomic prices, plan IDs, status values, USDG metadata reads, allowance/balance helpers, receipt success/revert, malformed decode, and rejection of stale selectors/signatures.

### Agent

Cover auth positive/negative paths, replay, audience, current-chain guard, every non-ACTIVE state, expiry during stream, abort, timeout, quota/concurrency release, signer mismatch, reservation retry, safe logging, demo backend health/failure, and no fake hardware claims.

### Web

Cover wrong chain, wallet rejection, USDG insufficient balance, approval rejection/revert/pending/success, stale allowance, every eligibility predicate, each plan rendering, exact plan rent call, receipt handling, session clearing, malformed SSE, expiry, safe rendering, refund, settlement, and re-rent.

---

## 25. Metrics for the Buildathon release

P0 success is not measured by real GPU throughput. The acceptance metrics are product/system correctness:

- 7 onchain-readable plans, 1 demo + 6 standard;
- successful real Plan 1 (6h) USDG rental;
- successful full Plan 0 lifecycle;
- exact escrow/refund/payout accounting;
- one real OmniRoute Browser→Agent path;
- authenticated inference after ACTIVE only;
- zero successful inference after expiry;
- zero double-rent acceptance;
- all critical local gates passing;
- reproducible explorer/transaction evidence.

---

## 26. Future product direction — explicitly not P0

After the Buildathon, ARCHcore may explore:

- provider-defined hourly rates;
- additional plans;
- multiple nodes/providers;
- marketplace discovery;
- real GPU/model adapters;
- availability/SLA measurement;
- prorated or uptime-based compensation;
- reputation;
- provider staking/slashing;
- hardware attestation;
- alternative payment assets;
- gas sponsorship/account abstraction;
- agent-to-agent compute purchasing.

These must not leak into P0 implementation unless this PRD is deliberately superseded.

---

## 27. External verification notes

The following current external facts were verified when preparing v0.5:

- Robinhood Chain Testnet uses chain ID `46630` and ETH as native gas token.
- Robinhood Chain is an Arbitrum-based chain.
- Paxos lists USDG on Robinhood Testnet at `0x7E955252E15c84f5768B83c41a71F9eba181802F` and states testnet tokens have no value.
- P0 still requires an onchain `decimals()` preflight before relying on six-decimal atomic plan values.

External facts are integration facts, not permission for implementation roles to override this PRD silently if a later environment differs. Any discrepancy becomes a blocking integration issue and must be reconciled explicitly.

---

## 28. Definition of done

### Specification done

All active PRD/ledger/runbook/prompts/env guidance agree on:

- USDG, not ETH, as rental escrow;
- ETH only for gas;
- seven frozen plan IDs;
- six-hour minimum commercial plan;
- five-minute testnet-only demo plan;
- plan-based nonpayable `rent(nodeId, planId)`;
- exact rental tuple;
- real OmniRoute;
- real onchain auth/lifecycle;
- explicit Demo Inference Backend;
- no physical-GPU requirement for P0;
- readiness definitions.

### CODE-READY

All required integrated local gates pass against the v0.5 interfaces.

### DEMO-READY

The real Robinhood Testnet + USDG + wallet + signer + OmniRoute + Agent + demo-backend lifecycle acceptance in Section 19 is demonstrated and reproducibly evidenced.

