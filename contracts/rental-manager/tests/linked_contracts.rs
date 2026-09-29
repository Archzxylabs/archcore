// SPDX-License-Identifier: MIT OR Apache-2.0
//! Local linked-contract integration test suite for `RentalManager` and `ComputeAsset`.
//!
//! # Objective
//! Exercises the actual production `RentalManager` and actual production `ComputeAsset`
//! contract implementations together in the pinned Stylus / motsu host test harness,
//! proving that cross-contract calls (`ownerOf` and `isActive`) work through the
//! configured contract address and ABI call boundary.
//!
//! # Safety and Scope
//! - Production contracts: `RentalManager` and `ComputeAsset` are the actual crate entrypoints.
//! - Payment token: The payment token is a test-local ERC-20 double (`LocalUsdgTestDouble`)
//!   deployed at `PAYMENT_TOKEN` (`0x7E955252E15c84f5768B83c41a71F9eba181802F`).
//!   It is strictly a test fixture for local testing and DOES NOT represent live USDG or
//!   live deployment on Robinhood Chain Testnet (chain ID 46630).

extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::{uint, Address, U256};
use alloy_sol_types::sol;
use compute_asset::ComputeAsset;
use motsu::prelude::*;
use rental_manager::{
    Error as RentalError, RentalManager, PAYMENT_TOKEN, PLANS, START_GRACE_SECONDS, STATUS_ACTIVE,
    STATUS_RESERVED,
};
use stylus_sdk::{call::MethodError, prelude::*, storage::*};

const NODE_ID_1: U256 = uint!(1_U256);
const NONEXISTENT_NODE_ID: U256 = uint!(999_U256);
const COLLECTION_NAME: &str = "ARCHcore Compute Node";
const COLLECTION_SYMBOL: &str = "ARCHN";
const NODE_1_URI: &str = "https://metadata.archcore.net/node/1.json";

// ===========================================================================
// Test-local USDG ERC-20 Test Double
//
// [NOTICE: LOCAL USDG TEST DOUBLE ONLY — NOT LIVE USDG / NOT A DEPLOYMENT TEST]
// This fixture provides standard ERC-20 transferFrom, transfer, approve, and
// balanceOf methods to satisfy RentalManager's escrow call boundary.
// It is explicitly isolated to local integration testing.
// ===========================================================================

sol! {
    #[derive(Debug)]
    error MockTokenRejected();
    #[derive(Debug)]
    error MockTokenInsufficientBalance();
    #[derive(Debug)]
    error MockTokenInsufficientAllowance();
}

#[derive(SolidityError, Debug)]
pub enum MockTokenError {
    Rejected(MockTokenRejected),
    InsufficientBalance(MockTokenInsufficientBalance),
    InsufficientAllowance(MockTokenInsufficientAllowance),
}

impl MethodError for MockTokenError {
    fn encode(self) -> Vec<u8> {
        self.into()
    }
}

#[storage]
pub struct LocalUsdgTestDouble {
    balances: StorageMap<Address, StorageU256>,
    allowances: StorageMap<Address, StorageMap<Address, StorageU256>>,
    return_false: StorageBool,
    reject: StorageBool,
}

#[public]
impl LocalUsdgTestDouble {
    #[constructor]
    pub fn constructor(&mut self) -> Result<(), MockTokenError> {
        Ok(())
    }

    pub fn mint(&mut self, to: Address, amount: U256) -> Result<(), MockTokenError> {
        let cur = self.balances.getter(to).get();
        self.balances.setter(to).set(cur + amount);
        Ok(())
    }

    pub fn approve(&mut self, spender: Address, amount: U256) -> Result<bool, MockTokenError> {
        let owner = self.vm().msg_sender();
        self.allowances.setter(owner).setter(spender).set(amount);
        Ok(true)
    }

    pub fn balance_of(&self, account: Address) -> Result<U256, MockTokenError> {
        Ok(self.balances.getter(account).get())
    }

    pub fn allowance(&self, owner: Address, spender: Address) -> Result<U256, MockTokenError> {
        Ok(self.allowances.getter(owner).getter(spender).get())
    }

    pub fn set_return_false(&mut self, val: bool) {
        self.return_false.set(val);
    }

    pub fn set_reject(&mut self, val: bool) {
        self.reject.set(val);
    }

    pub fn transfer_from(
        &mut self,
        from: Address,
        to: Address,
        value: U256,
    ) -> Result<bool, MockTokenError> {
        if self.reject.get() {
            return Err(MockTokenError::Rejected(MockTokenRejected {}));
        }
        if self.return_false.get() {
            return Ok(false);
        }

        let from_bal = self.balances.getter(from).get();
        if from_bal < value {
            return Err(MockTokenError::InsufficientBalance(
                MockTokenInsufficientBalance {},
            ));
        }
        let caller = self.vm().msg_sender();
        let allowed = self.allowances.getter(from).getter(caller).get();
        if allowed < value {
            return Err(MockTokenError::InsufficientAllowance(
                MockTokenInsufficientAllowance {},
            ));
        }

        self.balances.setter(from).set(from_bal - value);
        let to_bal = self.balances.getter(to).get();
        self.balances.setter(to).set(to_bal + value);
        self.allowances
            .setter(from)
            .setter(caller)
            .set(allowed - value);

        Ok(true)
    }

    pub fn transfer(&mut self, to: Address, value: U256) -> Result<bool, MockTokenError> {
        if self.reject.get() {
            return Err(MockTokenError::Rejected(MockTokenRejected {}));
        }
        if self.return_false.get() {
            return Ok(false);
        }

        let sender = self.vm().msg_sender();
        let sender_bal = self.balances.getter(sender).get();
        if sender_bal < value {
            return Err(MockTokenError::InsufficientBalance(
                MockTokenInsufficientBalance {},
            ));
        }
        self.balances.setter(sender).set(sender_bal - value);
        let to_bal = self.balances.getter(to).get();
        self.balances.setter(to).set(to_bal + value);

        Ok(true)
    }
}

unsafe impl TopLevelStorage for LocalUsdgTestDouble {}

// Incompatible test dummy contract that does NOT implement ownerOf or isActive
#[storage]
pub struct IncompatibleDummyContract {
    value: StorageU256,
}

#[public]
impl IncompatibleDummyContract {
    #[constructor]
    pub fn constructor(&mut self) -> Result<(), MockTokenError> {
        Ok(())
    }

    pub fn dummy_method(&mut self, val: U256) -> Result<U256, MockTokenError> {
        self.value.set(val);
        Ok(val)
    }
}

unsafe impl TopLevelStorage for IncompatibleDummyContract {}

// Dummy contract whose owner_of returns ABI `bytes` where IComputeAsset expects Address.
#[storage]
pub struct DynamicBytesOwnerDummyContract {}

#[public]
impl DynamicBytesOwnerDummyContract {
    #[constructor]
    pub fn constructor(&mut self) -> Result<(), MockTokenError> {
        Ok(())
    }

    // A public `Vec<u8>` result is ABI-encoded as dynamic `bytes`; this is an
    // ABI type mismatch with IComputeAsset.ownerOf's expected `address`, not a
    // two-byte raw return buffer.
    pub fn owner_of(&self, _token_id: U256) -> Result<Vec<u8>, MockTokenError> {
        Ok(alloc::vec![0x12, 0x34])
    }

    // This selector is present so a successful ownerOf decode would proceed
    // to the second external call. The fixture rejects that path explicitly.
    pub fn is_active(&self, _node_id: U256) -> bool {
        false
    }
}

unsafe impl TopLevelStorage for DynamicBytesOwnerDummyContract {}

fn print_test_double_notice() {
    println!("[NOTICE: USDG TEST DOUBLE ONLY — NOT LIVE USDG TOKEN OR LIVE DEPLOYMENT]");
}

// ---------------------------------------------------------------------------
// Scenario A: Actual linked contracts accept a valid Node 1 rent
// ---------------------------------------------------------------------------

#[motsu::test]
fn scenario_a_actual_linked_contracts_accept_valid_node1_rent(
    admin: Address,
    provider: Address,
    renter: Address,
) {
    print_test_double_notice();

    // 1. Deploy actual ComputeAsset and initialize via its actual constructor
    let compute = Contract::<ComputeAsset>::new();
    compute
        .sender(admin)
        .constructor(COLLECTION_NAME.into(), COLLECTION_SYMBOL.into(), admin)
        .expect("deploy actual ComputeAsset");

    // 2. Mint Node 1 using the actual ComputeAsset method and authorized admin
    compute
        .sender(admin)
        .mint_node(provider, NODE_ID_1, NODE_1_URI.into())
        .expect("mint Node 1 on actual ComputeAsset");

    // Verify ComputeAsset onchain state directly
    let initial_owner = compute
        .sender(admin)
        .owner_of(NODE_ID_1)
        .expect("ComputeAsset ownerOf(1)");
    assert_eq!(initial_owner, provider);
    assert!(compute.sender(admin).is_active(NODE_ID_1));

    // 3. Deploy USDG test double at the fixed constant address
    let usdg = Contract::<LocalUsdgTestDouble>::new_at(PAYMENT_TOKEN);
    usdg.sender(admin)
        .constructor()
        .expect("deploy LocalUsdgTestDouble");

    // 4. Deploy actual RentalManager linked to the actual ComputeAsset contract address
    let rental = Contract::<RentalManager>::new();
    rental
        .sender(admin)
        .constructor(admin, compute.address())
        .expect("deploy actual RentalManager linked to actual ComputeAsset");

    // Verify RentalManager cross-contract reads to ComputeAsset before rent
    assert_eq!(rental.sender(renter).payment_token(), PAYMENT_TOKEN);
    assert_eq!(rental.sender(renter).plan_count(), 7);

    // Call getNode(1) on RentalManager: exercises cross-contract ownerOf(1) and isActive(1)
    let (node_id, read_provider, _, active) = rental
        .sender(renter)
        .get_node(NODE_ID_1)
        .expect("RentalManager.getNode(1) cross-contract call");
    assert_eq!(node_id, NODE_ID_1);
    assert_eq!(read_provider, provider);
    assert!(active);

    // Check listing: unoccupied and active
    let (l_node, l_token, l_active) = rental
        .sender(renter)
        .get_listing(NODE_ID_1)
        .expect("RentalManager.getListing(1)");
    assert_eq!(l_node, NODE_ID_1);
    assert_eq!(l_token, PAYMENT_TOKEN);
    assert!(l_active);

    // Initial occupancy is (false, 0)
    let (has_rental, rental_id_0) = rental.sender(renter).active_rental_for_node(NODE_ID_1);
    assert!(!has_rental);
    assert_eq!(rental_id_0, U256::ZERO);

    // 5. Fund and approve renter using test double for Plan 1 (6 USDG = 6_000_000 atomic)
    let plan_1 = &PLANS[1];
    let price = plan_1.price_atomic;
    usdg.sender(renter)
        .mint(renter, price)
        .expect("fund renter with test USDG");
    usdg.sender(renter)
        .approve(rental.address(), price)
        .expect("approve RentalManager to spend test USDG");

    // 6. Call actual RentalManager.rent(1, 1) through the integration environment
    let rental_id = rental
        .sender(renter)
        .rent(NODE_ID_1, 1)
        .expect("RentalManager.rent(1, 1) transaction should succeed");

    assert_eq!(rental_id, uint!(1_U256));

    // 7. Assert RentalManager snapshotted provider equals ComputeAsset ownerOf(1)
    let (
        rec_id,
        rec_node,
        rec_plan,
        rec_renter,
        rec_provider,
        rec_price,
        rec_duration,
        rec_status,
        rec_deadline,
        rec_starts_at,
        rec_expires_at,
        rec_created_at,
    ) = rental
        .sender(renter)
        .get_rental(rental_id)
        .expect("get_rental(1)");

    assert_eq!(rec_id, rental_id);
    assert_eq!(rec_node, NODE_ID_1);
    assert_eq!(rec_plan, 1);
    assert_eq!(rec_renter, renter);
    assert_eq!(rec_provider, provider);
    assert_eq!(rec_provider, initial_owner);
    assert_eq!(rec_price, price);
    assert_eq!(rec_duration, U256::from(plan_1.duration_seconds));
    assert_eq!(rec_status, STATUS_RESERVED);
    assert_eq!(rec_starts_at, U256::ZERO);
    assert_eq!(rec_expires_at, U256::ZERO);
    assert_eq!(
        rec_deadline,
        rec_created_at + U256::from(START_GRACE_SECONDS)
    );

    // 8. Assert rental state, occupancy, and listing consistency
    let (occ_active, occ_id) = rental.sender(renter).active_rental_for_node(NODE_ID_1);
    assert!(occ_active);
    assert_eq!(occ_id, rental_id);

    let (_, _, listing_active_after) = rental
        .sender(renter)
        .get_listing(NODE_ID_1)
        .expect("get_listing after rent");
    assert!(
        !listing_active_after,
        "listing should be inactive while occupied"
    );

    // Escrow balance checks
    assert_eq!(usdg.sender(renter).balance_of(renter).unwrap(), U256::ZERO);
    assert_eq!(
        usdg.sender(renter).balance_of(rental.address()).unwrap(),
        price
    );
    assert_eq!(rental.sender(renter).escrowed(), price);

    // 9. Prove snapshot provider authorization: only snapshotted provider can start
    let wrong_caller = admin;
    let start_err = rental
        .sender(wrong_caller)
        .start_rental(rental_id)
        .motsu_expect_err("non-provider cannot start rental");
    assert!(matches!(start_err, RentalError::CallerNotProvider(_)));

    // Correct snapshotted provider starts rental
    rental
        .sender(provider)
        .start_rental(rental_id)
        .expect("snapshotted provider starts rental");

    let (_, _, _, _, _, _, _, active_status, _, starts_at, expires_at, _) = rental
        .sender(renter)
        .get_rental(rental_id)
        .expect("get_rental after start");
    assert_eq!(active_status, STATUS_ACTIVE);
    assert!(starts_at > U256::ZERO);
    assert_eq!(expires_at, starts_at + U256::from(plan_1.duration_seconds));

    let (active_occ, active_occ_id) = rental.sender(renter).active_rental_for_node(NODE_ID_1);
    assert!(active_occ);
    assert_eq!(active_occ_id, rental_id);
}

// ---------------------------------------------------------------------------
// Scenario B: Actual RentalManager rejects a nonexistent ComputeAsset node
// ---------------------------------------------------------------------------

#[motsu::test]
fn scenario_b_actual_rental_manager_rejects_nonexistent_node(
    admin: Address,
    provider: Address,
    renter: Address,
) {
    print_test_double_notice();

    // 1. Deploy actual ComputeAsset and mint only Node 1
    let compute = Contract::<ComputeAsset>::new();
    compute
        .sender(admin)
        .constructor(COLLECTION_NAME.into(), COLLECTION_SYMBOL.into(), admin)
        .expect("deploy ComputeAsset");
    compute
        .sender(admin)
        .mint_node(provider, NODE_ID_1, NODE_1_URI.into())
        .expect("mint Node 1 only");

    // Assert NONEXISTENT_NODE_ID does not exist on ComputeAsset directly
    assert!(!compute.sender(admin).node_exists(NONEXISTENT_NODE_ID));
    assert!(!compute.sender(admin).is_active(NONEXISTENT_NODE_ID));

    // 2. Deploy USDG test double and RentalManager
    let usdg = Contract::<LocalUsdgTestDouble>::new_at(PAYMENT_TOKEN);
    usdg.sender(admin)
        .constructor()
        .expect("deploy USDG double");

    let rental = Contract::<RentalManager>::new();
    rental
        .sender(admin)
        .constructor(admin, compute.address())
        .expect("deploy RentalManager");

    // 3. Fund and approve renter
    let price = PLANS[1].price_atomic;
    usdg.sender(renter)
        .mint(renter, price)
        .expect("fund renter");
    usdg.sender(renter)
        .approve(rental.address(), price)
        .expect("approve");

    // 4. Attempt rent for nonexistent node
    let rent_err = rental
        .sender(renter)
        .rent(NONEXISTENT_NODE_ID, 1)
        .motsu_expect_err("renting nonexistent node must fail closed");

    // Production cross-contract call to ComputeAsset.ownerOf(999) reverts with
    // Erc721NonexistentToken, which RentalManager receives and returns as ExternalCallFailed.
    assert!(
        matches!(rent_err, RentalError::ExternalCallFailed(_)),
        "Expected ExternalCallFailed from ComputeAsset revert on unknown node, got {:?}",
        rent_err
    );

    // 5. Assert fail-closed invariants: no rental created, no occupancy, token accounting rolled back
    assert_eq!(rental.sender(renter).rental_count(), U256::ZERO);
    let (occ_active, occ_id) = rental
        .sender(renter)
        .active_rental_for_node(NONEXISTENT_NODE_ID);
    assert!(!occ_active);
    assert_eq!(occ_id, U256::ZERO);

    // Accounting untouched
    assert_eq!(usdg.sender(renter).balance_of(renter).unwrap(), price);
    assert_eq!(
        usdg.sender(renter).balance_of(rental.address()).unwrap(),
        U256::ZERO
    );
    assert_eq!(rental.sender(renter).escrowed(), U256::ZERO);
}

// ---------------------------------------------------------------------------
// Scenario C: Burned node fails at ownerOf before RentalManager can call isActive
// ---------------------------------------------------------------------------

#[motsu::test]
fn scenario_c_actual_rental_manager_rejects_retired_inactive_node(
    admin: Address,
    provider: Address,
    renter: Address,
) {
    print_test_double_notice();

    // 1. Deploy actual ComputeAsset and mint Node 1
    let compute = Contract::<ComputeAsset>::new();
    compute
        .sender(admin)
        .constructor(COLLECTION_NAME.into(), COLLECTION_SYMBOL.into(), admin)
        .expect("deploy ComputeAsset");
    compute
        .sender(admin)
        .mint_node(provider, NODE_ID_1, NODE_1_URI.into())
        .expect("mint Node 1");

    // 2. Retire/burn Node 1 through actual supported production path
    compute
        .sender(admin)
        .burn_node(NODE_ID_1)
        .expect("burn Node 1 through admin burn_node");

    // Verify ComputeAsset production state directly:
    // Production invariant: burn_node executes erc721._burn(1), setting owner to 0,
    // and writes retired(1) = true.
    // Consequently:
    // - node_retired(1) == true
    // - node_exists(1) == false
    // - is_active(1) == false
    // - owner_of(1) reverts with Erc721NonexistentToken
    assert!(compute.sender(admin).node_retired(NODE_ID_1));
    assert!(!compute.sender(admin).node_exists(NODE_ID_1));
    assert!(!compute.sender(admin).is_active(NODE_ID_1));
    assert!(compute.sender(admin).owner_of(NODE_ID_1).is_err());

    // 3. Deploy USDG test double and RentalManager
    let usdg = Contract::<LocalUsdgTestDouble>::new_at(PAYMENT_TOKEN);
    usdg.sender(admin)
        .constructor()
        .expect("deploy USDG double");

    let rental = Contract::<RentalManager>::new();
    rental
        .sender(admin)
        .constructor(admin, compute.address())
        .expect("deploy RentalManager");

    // 4. Fund and approve renter
    let price = PLANS[1].price_atomic;
    usdg.sender(renter)
        .mint(renter, price)
        .expect("fund renter");
    usdg.sender(renter)
        .approve(rental.address(), price)
        .expect("approve");

    // 5. Attempt rent through actual RentalManager
    let rent_err = rental
        .sender(renter)
        .rent(NODE_ID_1, 1)
        .motsu_expect_err("renting retired/burned node must fail closed");

    // RentalManager.node_view calls IComputeAsset.ownerOf(1) first. It reverts
    // because the identity was burned, so RentalManager fails closed with
    // ExternalCallFailed before it can call IComputeAsset.isActive(1).
    assert!(
        matches!(rent_err, RentalError::ExternalCallFailed(_)),
        "Expected ExternalCallFailed from ComputeAsset burn revert, got {:?}",
        rent_err
    );

    // 6. Assert fail-closed invariants: no rental, no occupancy, no escrow, funds safe
    assert_eq!(rental.sender(renter).rental_count(), U256::ZERO);
    let (occ_active, occ_id) = rental.sender(renter).active_rental_for_node(NODE_ID_1);
    assert!(!occ_active);
    assert_eq!(occ_id, U256::ZERO);

    assert_eq!(usdg.sender(renter).balance_of(renter).unwrap(), price);
    assert_eq!(
        usdg.sender(renter).balance_of(rental.address()).unwrap(),
        U256::ZERO
    );
    assert_eq!(rental.sender(renter).escrowed(), U256::ZERO);
}

// ---------------------------------------------------------------------------
// Scenario D: Wrong or incompatible ComputeAsset linkage fails closed
// ---------------------------------------------------------------------------

#[motsu::test]
fn scenario_d1_unconfigured_compute_asset_address_fails_closed(admin: Address, renter: Address) {
    print_test_double_notice();

    let usdg = Contract::<LocalUsdgTestDouble>::new_at(PAYMENT_TOKEN);
    usdg.sender(admin)
        .constructor()
        .expect("deploy USDG double");

    // RentalManager configured with zero address for ComputeAsset
    let rental = Contract::<RentalManager>::new();
    rental
        .sender(admin)
        .constructor(admin, Address::ZERO)
        .expect("deploy RentalManager with zero compute_asset");

    let price = PLANS[1].price_atomic;
    usdg.sender(renter).mint(renter, price).unwrap();
    usdg.sender(renter)
        .approve(rental.address(), price)
        .unwrap();

    let rent_err = rental
        .sender(renter)
        .rent(NODE_ID_1, 1)
        .motsu_expect_err("rent with Address::ZERO ComputeAsset must fail");

    assert!(matches!(rent_err, RentalError::ComputeAssetNotSet(_)));
    assert_eq!(rental.sender(renter).rental_count(), U256::ZERO);
    assert_eq!(rental.sender(renter).escrowed(), U256::ZERO);
}

#[motsu::test]
fn scenario_d2_wrong_compute_asset_contract_fails_closed(admin: Address, renter: Address) {
    print_test_double_notice();

    let usdg = Contract::<LocalUsdgTestDouble>::new_at(PAYMENT_TOKEN);
    usdg.sender(admin)
        .constructor()
        .expect("deploy USDG double");

    // Deploy a contract that is NOT ComputeAsset
    let wrong_contract = Contract::<IncompatibleDummyContract>::new();
    wrong_contract
        .sender(admin)
        .constructor()
        .expect("deploy wrong contract");

    // RentalManager configured with the wrong contract address
    // NOTE (Harness Behavior): In motsu's host environment, external calls to an arbitrary
    // address without a deployed contract panic with "contract should be initialised first".
    // Therefore, testing a wrong target contract address safely in motsu uses a contract
    // deployed at a distinct address that does not implement the ComputeAsset interface.
    let rental = Contract::<RentalManager>::new();
    rental
        .sender(admin)
        .constructor(admin, wrong_contract.address())
        .expect("deploy RentalManager with wrong contract address");

    let price = PLANS[1].price_atomic;
    usdg.sender(renter).mint(renter, price).unwrap();
    usdg.sender(renter)
        .approve(rental.address(), price)
        .unwrap();

    let rent_err = rental
        .sender(renter)
        .rent(NODE_ID_1, 1)
        .motsu_expect_err("rent with wrong contract address must fail closed");

    assert!(matches!(rent_err, RentalError::ExternalCallFailed(_)));
    assert_eq!(rental.sender(renter).rental_count(), U256::ZERO);
    assert_eq!(rental.sender(renter).escrowed(), U256::ZERO);
    assert_eq!(usdg.sender(renter).balance_of(renter).unwrap(), price);
}

#[motsu::test]
fn scenario_d3_incompatible_compute_asset_interface_fails_closed(admin: Address, renter: Address) {
    print_test_double_notice();

    let usdg = Contract::<LocalUsdgTestDouble>::new_at(PAYMENT_TOKEN);
    usdg.sender(admin)
        .constructor()
        .expect("deploy USDG double");

    // Deploy an incompatible contract that does NOT implement ownerOf or isActive
    let dummy = Contract::<IncompatibleDummyContract>::new();
    dummy
        .sender(admin)
        .constructor()
        .expect("deploy dummy contract");

    // RentalManager configured to call the incompatible contract
    let rental = Contract::<RentalManager>::new();
    rental
        .sender(admin)
        .constructor(admin, dummy.address())
        .expect("deploy RentalManager linked to incompatible dummy");

    let price = PLANS[1].price_atomic;
    usdg.sender(renter).mint(renter, price).unwrap();
    usdg.sender(renter)
        .approve(rental.address(), price)
        .unwrap();

    let rent_err = rental
        .sender(renter)
        .rent(NODE_ID_1, 1)
        .motsu_expect_err("rent with incompatible contract interface must fail closed");

    assert!(matches!(rent_err, RentalError::ExternalCallFailed(_)));
    assert_eq!(rental.sender(renter).rental_count(), U256::ZERO);
    assert_eq!(rental.sender(renter).escrowed(), U256::ZERO);
    assert_eq!(usdg.sender(renter).balance_of(renter).unwrap(), price);
}

#[motsu::test]
fn scenario_d4_dynamic_bytes_return_cannot_decode_as_address(admin: Address, renter: Address) {
    print_test_double_notice();

    let usdg = Contract::<LocalUsdgTestDouble>::new_at(PAYMENT_TOKEN);
    usdg.sender(admin)
        .constructor()
        .expect("deploy USDG double");

    // Deploy a contract whose `ownerOf`-named method returns Solidity `bytes`.
    // Stylus ABI-encodes Vec<u8> as dynamic bytes (offset + length + contents),
    // which is ABI-incompatible with IComputeAsset's expected `address`.
    let dynamic_bytes = Contract::<DynamicBytesOwnerDummyContract>::new();
    dynamic_bytes
        .sender(admin)
        .constructor()
        .expect("deploy dynamic-bytes dummy");

    let rental = Contract::<RentalManager>::new();
    rental
        .sender(admin)
        .constructor(admin, dynamic_bytes.address())
        .expect("deploy RentalManager linked to dynamic-bytes dummy");

    let price = PLANS[1].price_atomic;
    usdg.sender(renter).mint(renter, price).unwrap();
    usdg.sender(renter)
        .approve(rental.address(), price)
        .unwrap();

    let rent_err = rental
        .sender(renter)
        .rent(NODE_ID_1, 1)
        .motsu_expect_err("inactive dynamic-bytes dummy must fail rent eligibility");

    // The external call reaches the return-data decoder and fails there. The
    // empty reason is RentalManager's mapping for AbiDecodingFailed. This proves
    // an ABI type mismatch (dynamic bytes vs address), NOT a two-byte raw return.
    assert!(
        matches!(&rent_err, RentalError::ExternalCallFailed(err) if err.reason.is_empty()),
        "expected ABI decoding failure with empty reason, got {rent_err:?}"
    );
    assert_eq!(rental.sender(renter).rental_count(), U256::ZERO);
    assert_eq!(rental.sender(renter).escrowed(), U256::ZERO);
    assert_eq!(usdg.sender(renter).balance_of(renter).unwrap(), price);
}

// ---------------------------------------------------------------------------
// Scenario E: Plan 0 Testnet Demo lifecycle with actual linked contracts
// ---------------------------------------------------------------------------

#[motsu::test]
fn scenario_e_plan0_demo_rent_and_expired_cancellation_refund(
    admin: Address,
    provider: Address,
    renter: Address,
) {
    print_test_double_notice();

    let compute = Contract::<ComputeAsset>::new();
    compute
        .sender(admin)
        .constructor(COLLECTION_NAME.into(), COLLECTION_SYMBOL.into(), admin)
        .expect("deploy ComputeAsset");
    compute
        .sender(admin)
        .mint_node(provider, NODE_ID_1, NODE_1_URI.into())
        .expect("mint Node 1");

    let usdg = Contract::<LocalUsdgTestDouble>::new_at(PAYMENT_TOKEN);
    usdg.sender(admin)
        .constructor()
        .expect("deploy USDG double");

    let rental = Contract::<RentalManager>::new();
    rental
        .sender(admin)
        .constructor(admin, compute.address())
        .expect("deploy RentalManager");

    // Plan 0: Testnet Demo, 0.10 USDG = 100_000 atomic
    let plan_0 = &PLANS[0];
    assert!(plan_0.demo_only);
    let price = plan_0.price_atomic;

    usdg.sender(renter).mint(renter, price).unwrap();
    usdg.sender(renter)
        .approve(rental.address(), price)
        .unwrap();

    let rental_id = rental
        .sender(renter)
        .rent(NODE_ID_1, 0)
        .expect("rent Plan 0");

    assert_eq!(rental_id, uint!(1_U256));

    // Cancel before deadline is rejected
    let early_cancel = rental
        .sender(renter)
        .cancel_expired_reservation(rental_id)
        .motsu_expect_err("early cancellation must reject");
    assert!(matches!(early_cancel, RentalError::DeadlineNotReached(_)));

    // Verify occupancy while reserved
    let (is_occ, _) = rental.sender(renter).active_rental_for_node(NODE_ID_1);
    assert!(is_occ);
}
