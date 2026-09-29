# Source-generated production ABI

ARCHcore P0's product target is [PRD v0.5](../../docs/ARCHcore_PRD_P0_v0.5_END_TO_END.md); exact ABI requirements are in the [interface ledger](../../docs/coordination/INTERFACE_CONTRACTS.md). This README is a tooling guide, not ABI authority.

`RentalManager.json` and `ComputeAsset.json` must be exported from final Rust/Stylus source through `npm run contracts:abi`. Never hand-edit production ABI. Run export twice and compare bytes. Conformance must cover selector, mutability, input/output types, exact tuple order, events, and source→artifact→client normalized results.

The v0.5 interface is USDG plan-based: `paymentToken`, `planCount`, `getPlan`, `getNode`, `getListing(uint256)->(uint256,address,bool)`, exact 12-field `getRental`, `activeRentalForNode`, and nonpayable `rent(uint256,uint8)`. Reject legacy payable `rent(uint256)`, fixed-wei/native-ETH economics, old listing/rental tuples, and ABI aliases `nodeIsRented` / `getActiveRentalForNode`.

`packages/chain` owns all positional tuple decoding, transaction encoding/receipt interpretation, plan/token/balance/allowance reads and normalized types. Web and Agent must not parse raw tuples. See PRD/ledger before changing generated artifacts.

## Historical note

Old v0.4 artifact inventories and tests are retained under `docs/archive/implementation-notes-v0.4/`. They describe the former native-ETH interface and are not evidence of v0.5 conformance.
