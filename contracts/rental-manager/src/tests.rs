//! Unit tests for the frozen P0 rental economics and USDG escrow.
use std::sync::atomic::Ordering;

use alloy_primitives::{uint, Address, FixedBytes, U256};
use motsu::prelude::*;
use openzeppelin_stylus::utils::introspection::erc165::IErc165;

use super::*;

const NODE_ID: U256 = uint!(1_U256);
const UNKNOWN_NODE_ID: U256 = uint!(9_U256);
const RENTAL_ID: U256 = uint!(1_U256);

/// motsu freezes the block timestamp here and exposes no setter.
const NOW: U256 = U256::from_limbs([1_735_689_600, 0, 0, 0]);
const GRACE: U256 = U256::from_limbs([START_GRACE_SECONDS, 0, 0, 0]);

const STATUS_RESERVED_U8: u8 = 1;
const STATUS_ACTIVE_U8: u8 = 2;
const STATUS_COMPLETED_U8: u8 = 3;
const STATUS_CANCELLED_U8: u8 = 4;

// ---------------------------------------------------------------------------
// Test-local ComputeAsset mock
// ---------------------------------------------------------------------------

sol! {
    #[derive(Debug)]
    error InvalidRecipient();
    #[derive(Debug)]
    error RegistryRejected();
}

#[derive(SolidityError, Debug)]
enum RegistryError {
    InvalidRecipient(InvalidRecipient),
    Rejected(RegistryRejected),
}

impl MethodError for RegistryError {
    fn encode(self) -> Vec<u8> {
        self.into()
    }
}

#[storage]
struct NodeRegistry {
    owners: StorageMap<U256, StorageAddress>,
    active: StorageMap<U256, StorageBool>,
    reject: StorageBool,
}

#[public]
impl NodeRegistry {
    #[constructor]
    fn constructor(&mut self) -> Result<(), RegistryError> {
        Ok(())
    }

    pub fn mint(&mut self, to: Address, token_id: U256) -> Result<(), RegistryError> {
        if to.is_zero() {
            return Err(RegistryError::InvalidRecipient(InvalidRecipient {}));
        }
        self.owners.setter(token_id).set(to);
        self.active.setter(token_id).set(true);
        Ok(())
    }

    pub fn transfer(&mut self, to: Address, token_id: U256) -> Result<(), RegistryError> {
        if to.is_zero() {
            return Err(RegistryError::InvalidRecipient(InvalidRecipient {}));
        }
        self.owners.setter(token_id).set(to);
        Ok(())
    }

    pub fn set_active(&mut self, token_id: U256, active: bool) {
        self.active.setter(token_id).set(active);
    }

    pub fn burn(&mut self, token_id: U256) {
        self.owners.setter(token_id).erase();
        self.active.setter(token_id).set(false);
    }

    pub fn set_reject(&mut self, reject: bool) {
        self.reject.set(reject);
    }

    pub fn owner_of(&self, token_id: U256) -> Result<Address, RegistryError> {
        self.guard()?;
        Ok(self.owners.getter(token_id).get())
    }

    pub fn is_active(&self, token_id: U256) -> Result<bool, RegistryError> {
        self.guard()?;
        Ok(self.active.getter(token_id).get())
    }

    fn guard(&self) -> Result<(), RegistryError> {
        if self.reject.get() {
            Err(RegistryError::Rejected(RegistryRejected {}))
        } else {
            Ok(())
        }
    }
}

unsafe impl TopLevelStorage for NodeRegistry {}

// ---------------------------------------------------------------------------
// Test-local MockUsdg ERC-20 contract
// ---------------------------------------------------------------------------

sol! {
    #[derive(Debug)]
    error MockTokenRejected();
    #[derive(Debug)]
    error MockTokenInsufficientBalance();
    #[derive(Debug)]
    error MockTokenInsufficientAllowance();
}

#[derive(SolidityError, Debug)]
enum MockTokenError {
    Rejected(MockTokenRejected),
    InsufficientBalance(MockTokenInsufficientBalance),
    InsufficientAllowance(MockTokenInsufficientAllowance),
}

impl MethodError for MockTokenError {
    fn encode(self) -> Vec<u8> {
        self.into()
    }
}

sol_interface! {
    interface IRentalManagerCallback {
        function rent(uint256 node_id, uint8 plan_id) external returns (uint256);
        function cancelExpiredReservation(uint256 rental_id) external;
        function settleAfterExpiry(uint256 rental_id) external;
    }
}

#[storage]
struct MockUsdg {
    balances: StorageMap<Address, StorageU256>,
    allowances: StorageMap<Address, StorageMap<Address, StorageU256>>,
    return_false: StorageBool,
    reject: StorageBool,
    reentrant_manager: StorageAddress,
    reentrant_action: StorageU256,
    reentrant_rental_id: StorageU256,
    last_reentrancy_reverted: StorageBool,
}

#[public]
impl MockUsdg {
    #[constructor]
    fn constructor(&mut self) -> Result<(), MockTokenError> {
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

    pub fn arm_reentrancy(&mut self, manager: Address, action: U256, rental_id: U256) {
        self.reentrant_manager.set(manager);
        self.reentrant_action.set(action);
        self.reentrant_rental_id.set(rental_id);
    }

    pub fn last_reentrancy_reverted(&self) -> bool {
        self.last_reentrancy_reverted.get()
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
        self.trigger_reentrancy();

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
        self.trigger_reentrancy();

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

impl MockUsdg {
    fn trigger_reentrancy(&mut self) {
        let manager = self.reentrant_manager.get();
        if !manager.is_zero() {
            let action = self.reentrant_action.get();
            let rental_id = self.reentrant_rental_id.get();
            self.reentrant_manager.set(Address::ZERO);

            let callback = IRentalManagerCallback::new(manager);
            let res = if action == uint!(1_U256) {
                callback.cancel_expired_reservation(&mut *self, rental_id)
            } else if action == uint!(2_U256) {
                callback.settle_after_expiry(&mut *self, rental_id)
            } else {
                callback.rent(&mut *self, NODE_ID, 0).map(|_| ())
            };
            self.last_reentrancy_reverted.set(res.is_err());
        }
    }
}

unsafe impl TopLevelStorage for MockUsdg {}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn deploy(
    owner: Address,
    provider: Address,
) -> (
    Contract<RentalManager>,
    Contract<NodeRegistry>,
    Contract<MockUsdg>,
) {
    let asset = Contract::<NodeRegistry>::new();
    asset
        .sender(owner)
        .constructor()
        .expect("should deploy mock registry");
    asset
        .sender(owner)
        .mint(provider, NODE_ID)
        .expect("should mint node identity");

    let usdg = Contract::<MockUsdg>::new_at(PAYMENT_TOKEN);
    usdg.sender(owner)
        .constructor()
        .expect("should deploy mock usdg");

    let rental = Contract::<RentalManager>::new();
    rental
        .sender(owner)
        .constructor(owner, asset.address())
        .expect("should deploy rental manager");

    (rental, asset, usdg)
}

fn fund_and_approve(
    usdg: &Contract<MockUsdg>,
    rental_address: Address,
    renter: Address,
    amount: U256,
) {
    usdg.sender(renter).mint(renter, amount).expect("mint");
    usdg.sender(renter)
        .approve(rental_address, amount)
        .expect("approve");
}

fn reserve(
    rental: &Contract<RentalManager>,
    usdg: &Contract<MockUsdg>,
    renter: Address,
    plan_id: u8,
) -> U256 {
    let plan = RentalManager::lookup_plan(plan_id).unwrap();
    fund_and_approve(usdg, rental.address(), renter, plan.price_atomic);
    rental
        .sender(renter)
        .rent(NODE_ID, plan_id)
        .expect("reservation should succeed")
}

fn with_grace<F: FnOnce()>(override_seconds: u64, f: F) {
    TEST_GRACE.store(override_seconds, Ordering::SeqCst);
    f();
    TEST_GRACE.store(u64::MAX, Ordering::SeqCst);
}

fn with_duration<F: FnOnce()>(override_seconds: u64, f: F) {
    TEST_DURATION.store(override_seconds, Ordering::SeqCst);
    f();
    TEST_DURATION.store(u64::MAX, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[motsu::test]
fn plans_catalog_has_exact_seven_plans(contract: Contract<RentalManager>, alice: Address) {
    assert_eq!(contract.sender(alice).plan_count(), 7);

    let expected = [
        (0u8, 300u64, uint!(100_000_U256), true, true),
        (1u8, 21_600u64, uint!(6_000_000_U256), true, false),
        (2u8, 43_200u64, uint!(11_400_000_U256), true, false),
        (3u8, 86_400u64, uint!(21_600_000_U256), true, false),
        (4u8, 604_800u64, uint!(142_800_000_U256), true, false),
        (5u8, 1_209_600u64, uint!(268_800_000_U256), true, false),
        (6u8, 2_592_000u64, uint!(504_000_000_U256), true, false),
    ];

    for (id, dur, price, act, demo) in expected {
        let (p_id, p_dur, p_price, p_act, p_demo) =
            contract.sender(alice).get_plan(id).expect("valid plan");
        assert_eq!(p_id, id);
        assert_eq!(p_dur, U256::from(dur));
        assert_eq!(p_price, price);
        assert_eq!(p_act, act);
        assert_eq!(p_demo, demo);
    }
}

#[motsu::test]
fn get_plan_rejects_invalid_ids(contract: Contract<RentalManager>, alice: Address) {
    let err = contract
        .sender(alice)
        .get_plan(7)
        .motsu_expect_err("plan 7 is invalid");
    assert!(matches!(
        err,
        Error::InvalidPlan(InvalidPlan { plan_id: 7 })
    ));

    let err2 = contract
        .sender(alice)
        .get_plan(255)
        .motsu_expect_err("plan 255 is invalid");
    assert!(matches!(
        err2,
        Error::InvalidPlan(InvalidPlan { plan_id: 255 })
    ));
}

#[motsu::test]
fn rent_rejects_invalid_plan_id(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    fund_and_approve(&usdg, rental.address(), bob, uint!(1_000_000_000_U256));

    let err = rental
        .sender(bob)
        .rent(NODE_ID, 7)
        .motsu_expect_err("plan 7 cannot be rented");
    assert!(matches!(
        err,
        Error::InvalidPlan(InvalidPlan { plan_id: 7 })
    ));
}

#[motsu::test]
fn rent_rejects_native_eth(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    fund_and_approve(&usdg, rental.address(), bob, uint!(1_000_000_000_U256));
    bob.fund(uint!(1_000_000_000_U256));

    let err = rental
        .sender_and_value(bob, uint!(1_U256))
        .rent(NODE_ID, 0)
        .motsu_expect_err("native ETH payment must be rejected");
    assert!(matches!(err, Error::NativePaymentNotAccepted(_)));
}

#[motsu::test]
fn rent_reserves_with_usdg_transfer(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let plan = RentalManager::lookup_plan(1).unwrap();
    let price = plan.price_atomic;

    fund_and_approve(&usdg, rental.address(), bob, price);
    assert_eq!(usdg.sender(bob).balance_of(bob).unwrap(), price);
    assert_eq!(
        usdg.sender(bob).balance_of(rental.address()).unwrap(),
        U256::ZERO
    );

    let rental_id = rental
        .sender(bob)
        .rent(NODE_ID, 1)
        .expect("reservation should succeed");

    assert_eq!(rental_id, RENTAL_ID);
    assert_eq!(usdg.sender(bob).balance_of(bob).unwrap(), U256::ZERO);
    assert_eq!(
        usdg.sender(bob).balance_of(rental.address()).unwrap(),
        price
    );
    assert_eq!(rental.sender(bob).escrowed(), price);
    assert_eq!(
        rental.sender(bob).rental_status(rental_id),
        STATUS_RESERVED_U8
    );
    assert_eq!(
        rental.sender(bob).active_rental_for_node(NODE_ID),
        (true, rental_id)
    );

    rental.assert_emitted(&RentalReserved {
        rentalId: rental_id,
        nodeId: NODE_ID,
        renter: bob,
        provider: charlie,
        planId: 1,
        priceAtomic: price,
        durationSeconds: U256::from(plan.duration_seconds),
        createdAt: NOW,
        startDeadline: NOW + GRACE,
    });
}

#[motsu::test]
fn rent_rejects_insufficient_usdg_balance(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let plan = RentalManager::lookup_plan(0).unwrap();

    // Approve enough but mint nothing
    usdg.sender(bob)
        .approve(rental.address(), plan.price_atomic)
        .expect("approve");

    let err = rental
        .sender(bob)
        .rent(NODE_ID, 0)
        .motsu_expect_err("insufficient USDG balance must revert");
    assert!(matches!(err, Error::ExternalCallFailed(_)));
    assert_eq!(rental.sender(bob).rental_count(), U256::ZERO);
    assert_eq!(rental.sender(bob).escrowed(), U256::ZERO);
}

#[motsu::test]
fn rent_rejects_insufficient_usdg_allowance(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let plan = RentalManager::lookup_plan(0).unwrap();

    // Mint tokens but do not approve
    usdg.sender(bob).mint(bob, plan.price_atomic).expect("mint");

    let err = rental
        .sender(bob)
        .rent(NODE_ID, 0)
        .motsu_expect_err("insufficient USDG allowance must revert");
    assert!(matches!(err, Error::ExternalCallFailed(_)));
    assert_eq!(rental.sender(bob).rental_count(), U256::ZERO);
    assert_eq!(rental.sender(bob).escrowed(), U256::ZERO);
}

#[motsu::test]
fn rent_rejects_usdg_false_return(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let plan = RentalManager::lookup_plan(0).unwrap();
    fund_and_approve(&usdg, rental.address(), bob, plan.price_atomic);

    usdg.sender(alice).set_return_false(true);

    let err = rental
        .sender(bob)
        .rent(NODE_ID, 0)
        .motsu_expect_err("USDG false return must fail the reservation");
    assert!(matches!(err, Error::TransferFailed(_)));
    assert_eq!(rental.sender(bob).rental_count(), U256::ZERO);
    assert_eq!(rental.sender(bob).escrowed(), U256::ZERO);
}

#[motsu::test]
fn rent_rejects_an_unknown_node(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let plan = RentalManager::lookup_plan(0).unwrap();
    fund_and_approve(&usdg, rental.address(), bob, plan.price_atomic);

    let err = rental
        .sender(bob)
        .rent(UNKNOWN_NODE_ID, 0)
        .motsu_expect_err("unknown node must be rejected");
    assert!(matches!(err, Error::NodeDoesNotExist(_)));
}

#[motsu::test]
fn rent_rejects_an_inactive_node(alice: Address, bob: Address, charlie: Address) {
    let (rental, asset, usdg) = deploy(alice, charlie);
    let plan = RentalManager::lookup_plan(0).unwrap();
    fund_and_approve(&usdg, rental.address(), bob, plan.price_atomic);
    asset.sender(alice).set_active(NODE_ID, false);

    let err = rental
        .sender(bob)
        .rent(NODE_ID, 0)
        .motsu_expect_err("inactive node must be rejected");
    assert!(matches!(err, Error::NodeNotActive(_)));
}

#[motsu::test]
fn rent_rejects_a_burned_node(alice: Address, bob: Address, charlie: Address) {
    let (rental, asset, usdg) = deploy(alice, charlie);
    let plan = RentalManager::lookup_plan(0).unwrap();
    fund_and_approve(&usdg, rental.address(), bob, plan.price_atomic);
    asset.sender(alice).burn(NODE_ID);

    let err = rental
        .sender(bob)
        .rent(NODE_ID, 0)
        .motsu_expect_err("burned node must be rejected");
    assert!(matches!(err, Error::NodeDoesNotExist(_)));
}

#[motsu::test]
fn rent_rejects_two_live_rentals_of_one_node(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let r_id = reserve(&rental, &usdg, bob, 0);

    let plan = RentalManager::lookup_plan(0).unwrap();
    fund_and_approve(&usdg, rental.address(), charlie, plan.price_atomic);

    let err = rental
        .sender(charlie)
        .rent(NODE_ID, 0)
        .motsu_expect_err("reserved node cannot be reserved again");
    assert!(matches!(err, Error::NodeAlreadyListed(_)));

    rental
        .sender(charlie)
        .start_rental(r_id)
        .expect("provider should start");

    let err2 = rental
        .sender(charlie)
        .rent(NODE_ID, 0)
        .motsu_expect_err("active node cannot be reserved again");
    assert!(matches!(err2, Error::NodeAlreadyListed(_)));
}

#[motsu::test]
fn provider_snapshot_freezes_provider(
    alice: Address,
    bob: Address,
    charlie: Address,
    dave: Address,
) {
    let (rental, asset, usdg) = deploy(alice, charlie);
    let rental_id = reserve(&rental, &usdg, bob, 0);

    // Transfer node identity in ComputeAsset to Dave
    asset
        .sender(alice)
        .transfer(dave, NODE_ID)
        .expect("transfer");

    // Dave cannot start rental because Charlie was snapshotted
    let err = rental
        .sender(dave)
        .start_rental(rental_id)
        .motsu_expect_err("new node owner is not the snapshotted provider");
    assert!(matches!(
        err,
        Error::CallerNotProvider(CallerNotProvider { caller, provider })
            if caller == dave && provider == charlie
    ));

    // Charlie can start rental
    rental
        .sender(charlie)
        .start_rental(rental_id)
        .expect("snapshotted provider can start");
}

#[motsu::test]
fn start_before_the_deadline_sets_expiry(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let plan = RentalManager::lookup_plan(1).unwrap();
    let r_id = reserve(&rental, &usdg, bob, 1);

    rental
        .sender(charlie)
        .start_rental(r_id)
        .expect("provider starts within grace window");

    assert_eq!(rental.sender(bob).rental_status(r_id), STATUS_ACTIVE_U8);
    let dur = U256::from(plan.duration_seconds);
    rental.assert_emitted(&RentalStarted {
        rentalId: r_id,
        nodeId: NODE_ID,
        renter: bob,
        provider: charlie,
        startsAt: NOW,
        expiresAt: NOW + dur,
    });
}

#[motsu::test]
fn start_strictly_before_deadline_rejects_at_deadline(
    alice: Address,
    bob: Address,
    charlie: Address,
) {
    with_grace(0, || {
        let (rental, _asset, usdg) = deploy(alice, charlie);
        let r_id = reserve(&rental, &usdg, bob, 0);

        let err = rental
            .sender(charlie)
            .start_rental(r_id)
            .motsu_expect_err("strictly before deadline rejects at deadline");
        assert!(matches!(err, Error::DeadlineAlreadyPassed(_)));
    });
}

#[motsu::test]
fn start_rejects_non_reserved_or_unknown(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);

    let err = rental
        .sender(charlie)
        .start_rental(uint!(999_U256))
        .motsu_expect_err("unknown rental cannot start");
    assert!(matches!(err, Error::RentalDoesNotExist(_)));

    let r_id = reserve(&rental, &usdg, bob, 0);
    rental.sender(charlie).start_rental(r_id).expect("start");

    let err2 = rental
        .sender(charlie)
        .start_rental(r_id)
        .motsu_expect_err("already active rental cannot start again");
    assert!(matches!(err2, Error::InvalidRentalState(_)));
}

#[motsu::test]
fn cancel_expired_reservation_refunds_renter(
    alice: Address,
    bob: Address,
    charlie: Address,
    dave: Address,
) {
    with_grace(0, || {
        let (rental, _asset, usdg) = deploy(alice, charlie);
        let plan = RentalManager::lookup_plan(0).unwrap();
        let price = plan.price_atomic;
        let r_id = reserve(&rental, &usdg, bob, 0);

        assert_eq!(usdg.sender(bob).balance_of(bob).unwrap(), U256::ZERO);

        // Dave (stranger) can permissionlessly trigger the cancellation
        rental
            .sender(dave)
            .cancel_expired_reservation(r_id)
            .expect("permissionless cancel at deadline should succeed");

        assert_eq!(usdg.sender(bob).balance_of(bob).unwrap(), price);
        assert_eq!(rental.sender(bob).escrowed(), U256::ZERO);
        assert_eq!(rental.sender(bob).rental_status(r_id), STATUS_CANCELLED_U8);
        assert_eq!(
            rental.sender(bob).active_rental_for_node(NODE_ID),
            (false, U256::ZERO)
        );

        rental.assert_emitted(&RentalCancelled {
            rentalId: r_id,
            nodeId: NODE_ID,
            renter: bob,
            refunded: price,
        });
    });
}

#[motsu::test]
fn cancel_before_the_deadline_is_rejected(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let r_id = reserve(&rental, &usdg, bob, 0);

    let err = rental
        .sender(bob)
        .cancel_expired_reservation(r_id)
        .motsu_expect_err("cancel before deadline must be rejected");
    assert!(matches!(err, Error::DeadlineNotReached(_)));
}

#[motsu::test]
fn cancel_rejects_an_active_rental(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let r_id = reserve(&rental, &usdg, bob, 0);
    rental.sender(charlie).start_rental(r_id).expect("start");

    let err = rental
        .sender(bob)
        .cancel_expired_reservation(r_id)
        .motsu_expect_err("active rental cannot be cancelled");
    assert!(matches!(err, Error::InvalidRentalState(_)));
}

#[motsu::test]
fn cancel_rollback_on_failed_usdg_transfer(alice: Address, bob: Address, charlie: Address) {
    with_grace(0, || {
        let (rental, _asset, usdg) = deploy(alice, charlie);
        let plan = RentalManager::lookup_plan(0).unwrap();
        let r_id = reserve(&rental, &usdg, bob, 0);

        usdg.sender(alice).set_return_false(true);

        let err = rental
            .sender(bob)
            .cancel_expired_reservation(r_id)
            .motsu_expect_err("failed refund transfer must roll back");
        assert!(matches!(err, Error::TransferFailed(_)));
        assert_eq!(rental.sender(bob).rental_status(r_id), STATUS_RESERVED_U8);
        assert_eq!(rental.sender(bob).escrowed(), plan.price_atomic);
    });
}

#[motsu::test]
fn settle_after_expiry_pays_provider(
    alice: Address,
    bob: Address,
    charlie: Address,
    dave: Address,
) {
    with_duration(0, || {
        let (rental, _asset, usdg) = deploy(alice, charlie);
        let plan = RentalManager::lookup_plan(0).unwrap();
        let price = plan.price_atomic;
        let r_id = reserve(&rental, &usdg, bob, 0);
        rental.sender(charlie).start_rental(r_id).expect("start");

        assert_eq!(
            usdg.sender(charlie).balance_of(charlie).unwrap(),
            U256::ZERO
        );

        // Dave (stranger) settles permissionlessly
        rental
            .sender(dave)
            .settle_after_expiry(r_id)
            .expect("settlement at expiry should succeed");

        assert_eq!(usdg.sender(charlie).balance_of(charlie).unwrap(), price);
        assert_eq!(rental.sender(bob).escrowed(), U256::ZERO);
        assert_eq!(rental.sender(bob).rental_status(r_id), STATUS_COMPLETED_U8);
        assert_eq!(
            rental.sender(bob).active_rental_for_node(NODE_ID),
            (false, U256::ZERO)
        );

        rental.assert_emitted(&RentalSettled {
            rentalId: r_id,
            nodeId: NODE_ID,
            provider: charlie,
            renter: bob,
            paid: price,
        });
    });
}

#[motsu::test]
fn settle_before_expiry_is_rejected(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let r_id = reserve(&rental, &usdg, bob, 0);
    rental.sender(charlie).start_rental(r_id).expect("start");

    let err = rental
        .sender(charlie)
        .settle_after_expiry(r_id)
        .motsu_expect_err("settle before expiry must be rejected");
    assert!(matches!(err, Error::DeadlineNotReached(_)));
}

#[motsu::test]
fn settle_rejects_a_reservation(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let r_id = reserve(&rental, &usdg, bob, 0);

    let err = rental
        .sender(charlie)
        .settle_after_expiry(r_id)
        .motsu_expect_err("settle on a reservation must be rejected");
    assert!(matches!(err, Error::InvalidRentalState(_)));
}

#[motsu::test]
fn settle_rollback_on_failed_usdg_transfer(alice: Address, bob: Address, charlie: Address) {
    with_duration(0, || {
        let (rental, _asset, usdg) = deploy(alice, charlie);
        let plan = RentalManager::lookup_plan(0).unwrap();
        let r_id = reserve(&rental, &usdg, bob, 0);
        rental.sender(charlie).start_rental(r_id).expect("start");

        usdg.sender(alice).set_return_false(true);

        let err = rental
            .sender(charlie)
            .settle_after_expiry(r_id)
            .motsu_expect_err("failed payout transfer must roll back");
        assert!(matches!(err, Error::TransferFailed(_)));
        assert_eq!(rental.sender(bob).rental_status(r_id), STATUS_ACTIVE_U8);
        assert_eq!(rental.sender(bob).escrowed(), plan.price_atomic);
    });
}

#[motsu::test]
fn terminal_paths_are_single_use(alice: Address, bob: Address, charlie: Address) {
    with_grace(0, || {
        let (rental, _asset, usdg) = deploy(alice, charlie);
        let r_id = reserve(&rental, &usdg, bob, 0);
        rental
            .sender(bob)
            .cancel_expired_reservation(r_id)
            .expect("cancel");

        let err = rental
            .sender(bob)
            .cancel_expired_reservation(r_id)
            .motsu_expect_err("cannot cancel twice");
        assert!(matches!(err, Error::InvalidRentalState(_)));
    });

    with_duration(0, || {
        let (rental, _asset, usdg) = deploy(alice, charlie);
        let r_id = reserve(&rental, &usdg, bob, 0);
        rental.sender(charlie).start_rental(r_id).expect("start");
        rental
            .sender(charlie)
            .settle_after_expiry(r_id)
            .expect("settle");

        let err = rental
            .sender(charlie)
            .settle_after_expiry(r_id)
            .motsu_expect_err("cannot settle twice");
        assert!(matches!(err, Error::InvalidRentalState(_)));
    });
}

#[motsu::test]
fn a_node_can_be_rented_again_after_each_terminal_state(
    alice: Address,
    bob: Address,
    charlie: Address,
) {
    // 1. Re-rent after CANCELLED
    with_grace(0, || {
        let (rental, _asset, usdg) = deploy(alice, charlie);
        let r1 = reserve(&rental, &usdg, bob, 0);
        rental
            .sender(bob)
            .cancel_expired_reservation(r1)
            .expect("cancel");

        let (listed_node, _, listed_active) = rental.sender(bob).get_listing(NODE_ID).unwrap();
        assert_eq!(listed_node, NODE_ID);
        assert!(listed_active);
        assert_eq!(
            rental.sender(bob).active_rental_for_node(NODE_ID),
            (false, U256::ZERO)
        );

        let r2 = reserve(&rental, &usdg, bob, 1);
        assert_eq!(r2, uint!(2_U256));
        assert_eq!(
            rental.sender(bob).active_rental_for_node(NODE_ID),
            (true, r2)
        );
    });

    // 2. Re-rent after COMPLETED
    with_duration(0, || {
        let (rental, _asset, usdg) = deploy(alice, charlie);
        let r1 = reserve(&rental, &usdg, bob, 0);
        rental.sender(charlie).start_rental(r1).expect("start");
        rental
            .sender(charlie)
            .settle_after_expiry(r1)
            .expect("settle");

        let (_, _, listed_active) = rental.sender(bob).get_listing(NODE_ID).unwrap();
        assert!(listed_active);
        assert_eq!(
            rental.sender(bob).active_rental_for_node(NODE_ID),
            (false, U256::ZERO)
        );

        let r2 = reserve(&rental, &usdg, bob, 2);
        assert_eq!(r2, uint!(2_U256));
        assert_eq!(
            rental.sender(bob).active_rental_for_node(NODE_ID),
            (true, r2)
        );
    });
}

#[motsu::test]
fn reentrancy_during_refund_is_rejected(alice: Address, bob: Address, charlie: Address) {
    with_grace(0, || {
        let (rental, _asset, usdg) = deploy(alice, charlie);
        let r_id = reserve(&rental, &usdg, bob, 0);

        // Arm reentrancy callback on USDG transfer
        usdg.sender(alice)
            .arm_reentrancy(rental.address(), uint!(1_U256), r_id);

        rental
            .sender(bob)
            .cancel_expired_reservation(r_id)
            .expect("outer cancel should succeed while inner reentrancy is blocked");

        assert!(usdg.sender(alice).last_reentrancy_reverted());
    });
}

#[motsu::test]
fn reentrancy_during_settle_is_rejected(alice: Address, bob: Address, charlie: Address) {
    with_duration(0, || {
        let (rental, _asset, usdg) = deploy(alice, charlie);
        let r_id = reserve(&rental, &usdg, bob, 0);
        rental.sender(charlie).start_rental(r_id).expect("start");

        usdg.sender(alice)
            .arm_reentrancy(rental.address(), uint!(2_U256), r_id);

        rental
            .sender(charlie)
            .settle_after_expiry(r_id)
            .expect("outer settle should succeed while inner reentrancy is blocked");

        assert!(usdg.sender(alice).last_reentrancy_reverted());
    });
}

#[motsu::test]
fn exact_getter_layouts_and_constants(alice: Address, bob: Address, charlie: Address) {
    let (rental, _asset, usdg) = deploy(alice, charlie);
    let plan = RentalManager::lookup_plan(1).unwrap();
    let price = plan.price_atomic;
    let dur = U256::from(plan.duration_seconds);

    // 1. paymentToken
    assert_eq!(rental.sender(alice).payment_token(), PAYMENT_TOKEN);

    // 2. getNode
    let (n_id, n_prov, n_name, n_act) = rental.sender(alice).get_node(NODE_ID).unwrap();
    assert_eq!(n_id, NODE_ID);
    assert_eq!(n_prov, charlie);
    assert_eq!(n_name, FixedBytes::ZERO);
    assert!(n_act);

    // 3. getListing
    let (l_id, l_tok, l_act) = rental.sender(alice).get_listing(NODE_ID).unwrap();
    assert_eq!(l_id, NODE_ID);
    assert_eq!(l_tok, PAYMENT_TOKEN);
    assert!(l_act);

    // 4. getRental
    let r_id = reserve(&rental, &usdg, bob, 1);
    let (
        ret_rid,
        ret_nid,
        ret_pid,
        ret_renter,
        ret_provider,
        ret_price,
        ret_dur,
        ret_status,
        ret_deadline,
        ret_starts_at,
        ret_expires_at,
        ret_created_at,
    ) = rental.sender(alice).get_rental(r_id).unwrap();

    assert_eq!(ret_rid, r_id);
    assert_eq!(ret_nid, NODE_ID);
    assert_eq!(ret_pid, 1u8);
    assert_eq!(ret_renter, bob);
    assert_eq!(ret_provider, charlie);
    assert_eq!(ret_price, price);
    assert_eq!(ret_dur, dur);
    assert_eq!(ret_status, STATUS_RESERVED_U8);
    assert_eq!(ret_deadline, NOW + GRACE);
    assert_eq!(ret_starts_at, U256::ZERO);
    assert_eq!(ret_expires_at, U256::ZERO);
    assert_eq!(ret_created_at, NOW);
}

#[motsu::test]
fn constructor_rejects_zero_owner(contract: Contract<RentalManager>, alice: Address) {
    let err = contract
        .sender(alice)
        .constructor(Address::ZERO, Address::ZERO)
        .motsu_expect_err("zero owner must be rejected");
    assert!(matches!(err, Error::OwnableInvalidOwner(_)));
}

#[motsu::test]
fn supports_erc165(contract: Contract<RentalManager>, alice: Address) {
    assert!(contract
        .sender(alice)
        .supports_interface(<RentalManager as IErc165>::interface_id()));
}
