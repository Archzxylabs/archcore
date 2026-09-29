// SPDX-License-Identifier: MIT OR Apache-2.0
//! ARCHcore `RentalManager` — node rental lifecycle and escrow (Arbitrum Stylus).
//!
//! A node identity (minted by `ComputeAsset`) can be reserved by selecting an
//! immutable plan. Payment is escrowed in USDG (ERC-20). The provider frozen
//! at reservation time must start it before the start-grace deadline; the
//! contract then enforces a hard expiry and settles the USDG escrow without any
//! off-chain receipt.
//!
//! # State machine
//!
//! ```text
//!   IDLE ──[rent(nodeId, planId) + USDG transferFrom]──▶ RESERVED
//!   RESERVED ─[startRental(rentalId) strictly before deadline]──▶ ACTIVE
//!   RESERVED ─[cancelExpiredReservation(rentalId) at/after deadline]──▶ CANCELLED (100% refund)
//!   ACTIVE ──[settleAfterExpiry(rentalId) at/after expiresAt]──▶ COMPLETED (100% provider payout)
//! ```
//!
//! Economics are frozen: constant payment token USDG `0x7E955252E15c84f5768B83c41a71F9eba181802F`,
//! seven immutable plans, start grace `120` seconds. There is no setter and no deployment parameter
//! that can replace them. Every transition follows checks-effects-interactions: storage and
//! escrow are closed before the external token transfer, a failed transfer reverts the
//! whole transaction, and a reentrancy lock rejects nested operations.

#![allow(
    clippy::module_name_repetitions,
    clippy::used_underscore_items,
    clippy::missing_errors_doc,
    missing_docs
)]
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::{
    address,
    aliases::{B32, U8},
    Address, Bytes, FixedBytes, U256,
};
use alloy_sol_types::sol;
use openzeppelin_stylus::access::ownable::{self, Ownable};
use openzeppelin_stylus::utils::introspection::erc165::IErc165;
use stylus_sdk::{
    call::MethodError,
    prelude::{sol_interface, *},
    storage::*,
};

// ---------------------------------------------------------------------------
// Frozen P0 constants and plan catalog
// ---------------------------------------------------------------------------

/// Constant USDG payment token on Robinhood Chain Testnet (46630).
pub const PAYMENT_TOKEN: Address = address!("7E955252E15c84f5768B83c41a71F9eba181802F");

/// Seconds the provider has to start a reservation.
pub const START_GRACE_SECONDS: u64 = 120;

/// Immutable plan definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    pub duration_seconds: u64,
    pub price_atomic: U256,
    pub active: bool,
    pub demo_only: bool,
}

/// Frozen plan catalog from PRD §6.3 / ledger §1.
pub const PLANS: [Plan; 7] = [
    // Plan 0: Testnet Demo, 5 min = 300s, 0.10 USDG = 100_000 atomic, active: true, demoOnly: true
    Plan {
        duration_seconds: 300,
        price_atomic: U256::from_limbs([100_000, 0, 0, 0]),
        active: true,
        demo_only: true,
    },
    // Plan 1: 6 Hours = 21600s, 6.00 USDG = 6_000_000 atomic, active: true, demoOnly: false
    Plan {
        duration_seconds: 21_600,
        price_atomic: U256::from_limbs([6_000_000, 0, 0, 0]),
        active: true,
        demo_only: false,
    },
    // Plan 2: 12 Hours = 43200s, 11.40 USDG = 11_400_000 atomic, active: true, demoOnly: false
    Plan {
        duration_seconds: 43_200,
        price_atomic: U256::from_limbs([11_400_000, 0, 0, 0]),
        active: true,
        demo_only: false,
    },
    // Plan 3: 24 Hours = 86400s, 21.60 USDG = 21_600_000 atomic, active: true, demoOnly: false
    Plan {
        duration_seconds: 86_400,
        price_atomic: U256::from_limbs([21_600_000, 0, 0, 0]),
        active: true,
        demo_only: false,
    },
    // Plan 4: 7 Days = 604800s, 142.80 USDG = 142_800_000 atomic, active: true, demoOnly: false
    Plan {
        duration_seconds: 604_800,
        price_atomic: U256::from_limbs([142_800_000, 0, 0, 0]),
        active: true,
        demo_only: false,
    },
    // Plan 5: 14 Days = 1209600s, 268.80 USDG = 268_800_000 atomic, active: true, demoOnly: false
    Plan {
        duration_seconds: 1_209_600,
        price_atomic: U256::from_limbs([268_800_000, 0, 0, 0]),
        active: true,
        demo_only: false,
    },
    // Plan 6: 30 Days = 2592000s, 504.00 USDG = 504_000_000 atomic, active: true, demoOnly: false
    Plan {
        duration_seconds: 2_592_000,
        price_atomic: U256::from_limbs([504_000_000, 0, 0, 0]),
        active: true,
        demo_only: false,
    },
];

/// Test-only overrides for the frozen grace and duration.
#[cfg(test)]
pub static TEST_GRACE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);
#[cfg(test)]
pub static TEST_DURATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(u64::MAX);

/// Sentinel stored in [`RentalManager::reentrancy_status`] while an external call runs.
const REENTRANCY_ENTERED: U256 = U256::from_limbs([1, 0, 0, 0]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

sol! {
    /// The caller is not the provider frozen for this rental.
    #[derive(Debug, PartialEq, Eq)]
    error CallerNotProvider(address caller, address provider);

    /// The node already has a non-terminal rental.
    #[derive(Debug, PartialEq, Eq)]
    error NodeAlreadyListed(uint256 node_id);

    /// No rental exists for this identifier.
    #[derive(Debug, PartialEq, Eq)]
    error RentalDoesNotExist(uint256 rental_id);

    /// The rental is not in the expected state for this operation.
    #[derive(Debug, PartialEq, Eq)]
    error InvalidRentalState(uint256 rental_id, uint8 expected, uint8 actual);

    /// This operation is only callable at or after a specific deadline.
    #[derive(Debug, PartialEq, Eq)]
    error DeadlineNotReached(uint256 deadline);

    /// This operation is only callable before a specific deadline.
    #[derive(Debug, PartialEq, Eq)]
    error DeadlineAlreadyPassed(uint256 deadline);

    /// The node identity does not exist in `ComputeAsset`.
    #[derive(Debug, PartialEq, Eq)]
    error NodeDoesNotExist(uint256 node_id);

    /// The node identity exists but is not active.
    #[derive(Debug, PartialEq, Eq)]
    error NodeNotActive(uint256 node_id);

    /// The requested plan ID does not exist in the plan catalog.
    #[derive(Debug, PartialEq, Eq)]
    error InvalidPlan(uint8 plan_id);

    /// The requested plan is not active.
    #[derive(Debug, PartialEq, Eq)]
    error PlanNotActive(uint8 plan_id);

    /// Native ETH payment was sent to a nonpayable method.
    #[derive(Debug, PartialEq, Eq)]
    error NativePaymentNotAccepted();

    /// The external contract call reverted.
    #[derive(Debug, PartialEq, Eq)]
    error ExternalCallFailed(bytes reason);

    /// The renter address is invalid.
    #[derive(Debug, PartialEq, Eq)]
    error InvalidRenter();

    /// The node identity is not registered with a linked `ComputeAsset`.
    #[derive(Debug, PartialEq, Eq)]
    error ComputeAssetNotSet();

    /// An ERC-20 token transfer or transferFrom failed or returned false.
    #[derive(Debug, PartialEq, Eq)]
    error TransferFailed(address to, uint256 amount);

    /// A payout is already in progress. Nested calls are rejected.
    #[derive(Debug, PartialEq, Eq)]
    error Reentrancy();
}

/// Errors surfaced by [`RentalManager`].
#[derive(SolidityError, Debug)]
pub enum Error {
    CallerNotProvider(CallerNotProvider),
    NodeAlreadyListed(NodeAlreadyListed),
    RentalDoesNotExist(RentalDoesNotExist),
    InvalidRentalState(InvalidRentalState),
    DeadlineNotReached(DeadlineNotReached),
    DeadlineAlreadyPassed(DeadlineAlreadyPassed),
    NodeDoesNotExist(NodeDoesNotExist),
    NodeNotActive(NodeNotActive),
    InvalidPlan(InvalidPlan),
    PlanNotActive(PlanNotActive),
    NativePaymentNotAccepted(NativePaymentNotAccepted),
    InvalidRenter(InvalidRenter),
    ComputeAssetNotSet(ComputeAssetNotSet),
    TransferFailed(TransferFailed),
    Reentrancy(Reentrancy),
    OwnableUnauthorizedAccount(ownable::OwnableUnauthorizedAccount),
    OwnableInvalidOwner(ownable::OwnableInvalidOwner),
    ExternalCallFailed(ExternalCallFailed),
}

impl MethodError for Error {
    fn encode(self) -> Vec<u8> {
        self.into()
    }
}

impl From<ownable::Error> for Error {
    fn from(value: ownable::Error) -> Self {
        match value {
            ownable::Error::UnauthorizedAccount(e) => Self::OwnableUnauthorizedAccount(e),
            ownable::Error::InvalidOwner(e) => Self::OwnableInvalidOwner(e),
        }
    }
}

#[allow(deprecated)]
impl From<stylus_sdk::call::Error> for Error {
    fn from(value: stylus_sdk::call::Error) -> Self {
        match value {
            #[allow(deprecated)]
            stylus_sdk::call::Error::Revert(reason) => {
                Self::ExternalCallFailed(ExternalCallFailed {
                    reason: Bytes::from(reason),
                })
            }
            #[allow(deprecated)]
            stylus_sdk::call::Error::AbiDecodingFailed(_) => {
                Self::ExternalCallFailed(ExternalCallFailed {
                    reason: Bytes::new(),
                })
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Rental status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RentalStatus {
    None = 0,
    Reserved = 1,
    Active = 2,
    Completed = 3,
    Cancelled = 4,
}

pub const STATUS_NONE: u8 = RentalStatus::None as u8;
pub const STATUS_RESERVED: u8 = RentalStatus::Reserved as u8;
pub const STATUS_ACTIVE: u8 = RentalStatus::Active as u8;
pub const STATUS_COMPLETED: u8 = RentalStatus::Completed as u8;
pub const STATUS_CANCELLED: u8 = RentalStatus::Cancelled as u8;

// ---------------------------------------------------------------------------
// External interfaces
// ---------------------------------------------------------------------------

sol_interface! {
    interface IComputeAsset {
        function ownerOf(uint256 token_id) external view returns (address owner);
        function isActive(uint256 node_id) external view returns (bool active);
    }

    interface IErc20 {
        function transferFrom(address from, address to, uint256 value) external returns (bool);
        function transfer(address to, uint256 value) external returns (bool);
    }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

#[storage]
#[entrypoint]
pub struct RentalManager {
    pub ownable: Ownable,
    pub compute_asset: StorageAddress,
    pub rental_counter: StorageU256,
    pub escrowed: StorageU256,
    pub reentrancy_status: StorageU256,
    pub r_node_id: StorageMap<U256, StorageU256>,
    pub r_plan_id: StorageMap<U256, StorageU8>,
    pub r_renter: StorageMap<U256, StorageAddress>,
    pub r_provider: StorageMap<U256, StorageAddress>,
    pub r_price: StorageMap<U256, StorageU256>,
    pub r_duration: StorageMap<U256, StorageU256>,
    pub r_status: StorageMap<U256, StorageU8>,
    pub r_start_deadline: StorageMap<U256, StorageU256>,
    pub r_starts_at: StorageMap<U256, StorageU256>,
    pub r_expires_at: StorageMap<U256, StorageU256>,
    pub r_created_at: StorageMap<U256, StorageU256>,
    pub node_to_rental: StorageMap<U256, StorageU256>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rental {
    pub node_id: U256,
    pub plan_id: u8,
    pub renter: Address,
    pub provider: Address,
    pub price: U256,
    pub duration: U256,
    pub status: u8,
    pub start_deadline: U256,
    pub starts_at: U256,
    pub expires_at: U256,
    pub created_at: U256,
}

// ---------------------------------------------------------------------------
// Public API — Production RentalManager ABI exactly per ledger §2
// ---------------------------------------------------------------------------

#[public]
#[implements(IErc165)]
impl RentalManager {
    #[constructor]
    pub fn constructor(&mut self, owner: Address, compute_asset: Address) -> Result<(), Error> {
        self.ownable.constructor(owner)?;
        self.compute_asset.set(compute_asset);
        self.rental_counter.set(U256::ZERO);
        self.escrowed.set(U256::ZERO);
        self.reentrancy_status.set(U256::ZERO);
        Ok(())
    }

    /// Frozen payment token address (USDG).
    pub fn payment_token(&self) -> Address {
        PAYMENT_TOKEN
    }

    /// Frozen plan count: 7 immutable plans.
    pub fn plan_count(&self) -> u8 {
        PLANS.len() as u8
    }

    /// Plan definition for `plan_id`.
    ///
    /// Tuple: `(planId, durationSeconds, priceAtomic, active, demoOnly)`.
    pub fn get_plan(&self, plan_id: u8) -> Result<(u8, U256, U256, bool, bool), Error> {
        let plan = Self::lookup_plan(plan_id)?;
        Ok((
            plan_id,
            U256::from(plan.duration_seconds),
            plan.price_atomic,
            plan.active,
            plan.demo_only,
        ))
    }

    /// Returns the node as known to the linked `ComputeAsset`.
    ///
    /// Shape: `(nodeId, provider, name, active)`.
    pub fn get_node(&self, node_id: U256) -> Result<(U256, Address, FixedBytes<32>, bool), Error> {
        match self.node_view(node_id) {
            Ok((provider, active)) => Ok((node_id, provider, FixedBytes::ZERO, active)),
            Err(Error::NodeDoesNotExist(_)) => {
                Ok((node_id, Address::ZERO, FixedBytes::ZERO, false))
            }
            Err(other) => Err(other),
        }
    }

    /// Returns the listing for `node_id`.
    ///
    /// Shape: `(nodeId, paymentToken, active)`.
    pub fn get_listing(&self, node_id: U256) -> Result<(U256, Address, bool), Error> {
        let listed = match self.node_view(node_id) {
            Ok((_, true)) => !self.node_is_occupied(node_id),
            Ok((_, false)) | Err(Error::NodeDoesNotExist(_)) => false,
            Err(other) => return Err(other),
        };
        Ok((node_id, PAYMENT_TOKEN, listed))
    }

    /// Returns the 12-field rental record for `rental_id`.
    ///
    /// Shape: `(rentalId, nodeId, planId, renter, provider, priceAtomic,
    /// durationSeconds, status, startDeadline, startsAt, expiresAt, createdAt)`.
    pub fn get_rental(
        &self,
        rental_id: U256,
    ) -> Result<
        (
            U256,
            U256,
            u8,
            Address,
            Address,
            U256,
            U256,
            u8,
            U256,
            U256,
            U256,
            U256,
        ),
        Error,
    > {
        let rental = self.fetch_rental(rental_id)?;
        Ok((
            rental_id,
            rental.node_id,
            rental.plan_id,
            rental.renter,
            rental.provider,
            rental.price,
            rental.duration,
            rental.status,
            rental.start_deadline,
            rental.starts_at,
            rental.expires_at,
            rental.created_at,
        ))
    }

    /// Returns `(hasRental, rentalId)`.
    ///
    /// Occupancy selector: returns `(true, id)` for `RESERVED` or `ACTIVE`,
    /// and `(false, 0)` when idle or terminal.
    pub fn active_rental_for_node(&self, node_id: U256) -> (bool, U256) {
        let rental_id = self.node_to_rental.getter(node_id).get();
        match self.fetch_rental(rental_id) {
            Ok(rental) if is_non_terminal(rental.status) => (true, rental_id),
            _ => (false, U256::ZERO),
        }
    }

    /// Reserve `node_id` under `plan_id`. Nonpayable.
    ///
    /// Transferred exact `priceAtomic` in USDG using `transferFrom`.
    pub fn rent(&mut self, node_id: U256, plan_id: u8) -> Result<U256, Error> {
        self.enter()?;
        let outcome = self.rent_inner(node_id, plan_id);
        self.exit();
        outcome
    }

    /// Start a reserved rental.
    ///
    /// Only the provider frozen at reservation time may call this, strictly before `startDeadline`.
    pub fn start_rental(&mut self, rental_id: U256) -> Result<(), Error> {
        self.enter()?;
        let outcome = self.start_inner(rental_id);
        self.exit();
        outcome
    }

    /// Cancel an expired reservation.
    ///
    /// Permissionless at `now >= startDeadline`. Refunds 100% of escrow to renter.
    pub fn cancel_expired_reservation(&mut self, rental_id: U256) -> Result<(), Error> {
        self.enter()?;
        let outcome = self.cancel_inner(rental_id);
        self.exit();
        outcome
    }

    /// Settle an active rental after expiry.
    ///
    /// Permissionless at `now >= expiresAt`. Pays 100% of escrow to frozen provider.
    pub fn settle_after_expiry(&mut self, rental_id: U256) -> Result<(), Error> {
        self.enter()?;
        let outcome = self.settle_inner(rental_id);
        self.exit();
        outcome
    }
}

// ---------------------------------------------------------------------------
// ERC-165
// ---------------------------------------------------------------------------

#[public]
impl IErc165 for RentalManager {
    fn supports_interface(&self, interface_id: B32) -> bool {
        <Self as IErc165>::interface_id() == interface_id
    }
}

// ---------------------------------------------------------------------------
// Events — per PRD §10.11 and ledger §2
// ---------------------------------------------------------------------------

sol! {
    /// Emitted when a renter reserves a node and the provider is frozen.
    #[derive(Debug, PartialEq, Eq)]
    event RentalReserved(
        uint256 indexed rentalId,
        uint256 indexed nodeId,
        address indexed renter,
        address provider,
        uint8 planId,
        uint256 priceAtomic,
        uint256 durationSeconds,
        uint256 createdAt,
        uint256 startDeadline
    );

    /// Emitted when the frozen provider starts a reservation.
    #[derive(Debug, PartialEq, Eq)]
    event RentalStarted(
        uint256 indexed rentalId,
        uint256 indexed nodeId,
        address indexed renter,
        address provider,
        uint256 startsAt,
        uint256 expiresAt
    );

    /// Emitted when an elapsed reservation is cancelled and fully refunded.
    #[derive(Debug, PartialEq, Eq)]
    event RentalCancelled(
        uint256 indexed rentalId,
        uint256 indexed nodeId,
        address indexed renter,
        uint256 refunded
    );

    /// Emitted when an elapsed rental is settled and fully paid to its provider.
    #[derive(Debug, PartialEq, Eq)]
    event RentalSettled(
        uint256 indexed rentalId,
        uint256 indexed nodeId,
        address indexed provider,
        address renter,
        uint256 paid
    );
}

// ---------------------------------------------------------------------------
// Internal helpers and crate methods
// ---------------------------------------------------------------------------

impl RentalManager {
    /// Look up a plan from the immutable 7-plan catalog.
    pub fn lookup_plan(plan_id: u8) -> Result<&'static Plan, Error> {
        let index = plan_id as usize;
        if index < PLANS.len() {
            Ok(&PLANS[index])
        } else {
            Err(Error::InvalidPlan(InvalidPlan { plan_id }))
        }
    }

    /// The `ComputeAsset` contract node identities are read from.
    pub fn compute_asset(&self) -> Address {
        self.compute_asset.get()
    }

    /// Total number of rentals ever created (also the latest `rental_id`).
    pub fn rental_count(&self) -> U256 {
        self.rental_counter.get()
    }

    /// Sum of the price of every non-terminal rental.
    pub fn escrowed(&self) -> U256 {
        self.escrowed.get()
    }

    /// Returns the status of a rental, or [`RentalStatus::None`] if unknown.
    pub fn rental_status(&self, rental_id: U256) -> u8 {
        self.fetch_rental(rental_id)
            .map(|rental| rental.status)
            .unwrap_or(STATUS_NONE)
    }

    /// `true` while the node's latest rental is `RESERVED` or `ACTIVE`.
    pub fn node_is_occupied(&self, node_id: U256) -> bool {
        self.active_rental_for_node(node_id).0
    }

    fn rent_inner(&mut self, node_id: U256, plan_id: u8) -> Result<U256, Error> {
        // Reject native ETH payment.
        if !self.vm().msg_value().is_zero() {
            return Err(Error::NativePaymentNotAccepted(NativePaymentNotAccepted {}));
        }

        let plan = Self::lookup_plan(plan_id)?;
        if !plan.active {
            return Err(Error::PlanNotActive(PlanNotActive { plan_id }));
        }

        let renter = self.vm().msg_sender();
        if renter.is_zero() {
            return Err(Error::InvalidRenter(InvalidRenter {}));
        }

        let (provider, active) = self.node_view(node_id)?;
        if !active {
            return Err(Error::NodeNotActive(NodeNotActive { node_id }));
        }
        if self.node_is_occupied(node_id) {
            return Err(Error::NodeAlreadyListed(NodeAlreadyListed { node_id }));
        }

        let now = self.now();
        let start_deadline = now + U256::from(self.grace_seconds());
        let rental_id = self.rental_counter.get() + U256::from(1u32);

        let price_atomic = plan.price_atomic;
        let duration_seconds = U256::from(plan.duration_seconds);

        // Effects before interactions
        self.rental_counter.set(rental_id);
        self.r_node_id.setter(rental_id).set(node_id);
        self.r_plan_id.setter(rental_id).set(U8::from(plan_id));
        self.r_renter.setter(rental_id).set(renter);
        self.r_provider.setter(rental_id).set(provider);
        self.r_price.setter(rental_id).set(price_atomic);
        self.r_duration.setter(rental_id).set(duration_seconds);
        self.r_status
            .setter(rental_id)
            .set(U8::from(STATUS_RESERVED));
        self.r_start_deadline.setter(rental_id).set(start_deadline);
        self.r_starts_at.setter(rental_id).set(U256::ZERO);
        self.r_expires_at.setter(rental_id).set(U256::ZERO);
        self.r_created_at.setter(rental_id).set(now);
        self.node_to_rental.setter(node_id).set(rental_id);
        self.credit_escrow(price_atomic);

        log(
            self.vm(),
            RentalReserved {
                rentalId: rental_id,
                nodeId: node_id,
                renter,
                provider,
                planId: plan_id,
                priceAtomic: price_atomic,
                durationSeconds: duration_seconds,
                createdAt: now,
                startDeadline: start_deadline,
            },
        );

        // Interaction: transfer USDG from renter to this contract.
        // Fails if token transfer reverts or returns false; transaction rolls back atomically.
        self.pull_tokens(renter, price_atomic)?;

        Ok(rental_id)
    }

    fn start_inner(&mut self, rental_id: U256) -> Result<(), Error> {
        let caller = self.vm().msg_sender();
        let now = self.now();
        let rental = self.fetch_rental(rental_id)?;

        if rental.status != STATUS_RESERVED {
            return Err(Error::InvalidRentalState(InvalidRentalState {
                rental_id,
                expected: STATUS_RESERVED,
                actual: rental.status,
            }));
        }
        // Valid strictly before the deadline, so `now == startDeadline` is too late.
        if now >= rental.start_deadline {
            return Err(Error::DeadlineAlreadyPassed(DeadlineAlreadyPassed {
                deadline: rental.start_deadline,
            }));
        }
        if caller != rental.provider {
            return Err(Error::CallerNotProvider(CallerNotProvider {
                caller,
                provider: rental.provider,
            }));
        }

        let duration = self.duration_seconds(rental.duration);
        let expires_at = now + duration;
        self.r_status.setter(rental_id).set(U8::from(STATUS_ACTIVE));
        self.r_starts_at.setter(rental_id).set(now);
        self.r_expires_at.setter(rental_id).set(expires_at);

        log(
            self.vm(),
            RentalStarted {
                rentalId: rental_id,
                nodeId: rental.node_id,
                renter: rental.renter,
                provider: rental.provider,
                startsAt: now,
                expiresAt: expires_at,
            },
        );

        Ok(())
    }

    fn cancel_inner(&mut self, rental_id: U256) -> Result<(), Error> {
        let now = self.now();
        let rental = self.fetch_rental(rental_id)?;

        if rental.status != STATUS_RESERVED {
            return Err(Error::InvalidRentalState(InvalidRentalState {
                rental_id,
                expected: STATUS_RESERVED,
                actual: rental.status,
            }));
        }
        // Valid at the deadline itself: provider start window is closed.
        if now < rental.start_deadline {
            return Err(Error::DeadlineNotReached(DeadlineNotReached {
                deadline: rental.start_deadline,
            }));
        }

        self.close(rental_id, rental.node_id, STATUS_CANCELLED, rental.price);

        log(
            self.vm(),
            RentalCancelled {
                rentalId: rental_id,
                nodeId: rental.node_id,
                renter: rental.renter,
                refunded: rental.price,
            },
        );

        // Interaction last. Revert here rolls effects back atomically.
        self.transfer_tokens(rental.renter, rental.price)?;
        Ok(())
    }

    fn settle_inner(&mut self, rental_id: U256) -> Result<(), Error> {
        let now = self.now();
        let rental = self.fetch_rental(rental_id)?;

        if rental.status != STATUS_ACTIVE {
            return Err(Error::InvalidRentalState(InvalidRentalState {
                rental_id,
                expected: STATUS_ACTIVE,
                actual: rental.status,
            }));
        }
        // Valid at expiry itself.
        if now < rental.expires_at {
            return Err(Error::DeadlineNotReached(DeadlineNotReached {
                deadline: rental.expires_at,
            }));
        }

        self.close(rental_id, rental.node_id, STATUS_COMPLETED, rental.price);

        log(
            self.vm(),
            RentalSettled {
                rentalId: rental_id,
                nodeId: rental.node_id,
                provider: rental.provider,
                renter: rental.renter,
                paid: rental.price,
            },
        );

        // Interaction last. Revert here rolls effects back atomically.
        self.transfer_tokens(rental.provider, rental.price)?;
        Ok(())
    }

    fn close(&mut self, rental_id: U256, node_id: U256, terminal: u8, price: U256) {
        self.r_status.setter(rental_id).set(U8::from(terminal));
        self.debit_escrow(price);
        let _ = node_id;
    }

    /// Pull tokens from `from` into this contract via ERC-20 `transferFrom`.
    fn pull_tokens(&mut self, from: Address, amount: U256) -> Result<(), Error> {
        if amount.is_zero() {
            return Ok(());
        }
        let to = self.vm().contract_address();
        let token = IErc20::new(PAYMENT_TOKEN);
        let success = token.transfer_from(self, from, to, amount)?;
        if !success {
            return Err(Error::TransferFailed(TransferFailed { to, amount }));
        }
        Ok(())
    }

    /// Send tokens from this contract to `to` via ERC-20 `transfer`.
    fn transfer_tokens(&mut self, to: Address, amount: U256) -> Result<(), Error> {
        if amount.is_zero() {
            return Ok(());
        }
        let token = IErc20::new(PAYMENT_TOKEN);
        let success = token.transfer(self, to, amount)?;
        if !success {
            return Err(Error::TransferFailed(TransferFailed { to, amount }));
        }
        Ok(())
    }

    fn enter(&mut self) -> Result<(), Error> {
        if !self.reentrancy_status.get().is_zero() {
            return Err(Error::Reentrancy(Reentrancy {}));
        }
        self.reentrancy_status.set(REENTRANCY_ENTERED);
        Ok(())
    }

    fn exit(&mut self) {
        self.reentrancy_status.set(U256::ZERO);
    }

    fn credit_escrow(&mut self, amount: U256) {
        self.escrowed.set(self.escrowed.get() + amount);
    }

    fn debit_escrow(&mut self, amount: U256) {
        self.escrowed.set(self.escrowed.get() - amount);
    }

    fn node_view(&self, node_id: U256) -> Result<(Address, bool), Error> {
        let asset = self.compute_asset.get();
        if asset.is_zero() {
            return Err(Error::ComputeAssetNotSet(ComputeAssetNotSet {}));
        }
        let collection = IComputeAsset::new(asset);
        let provider = collection.owner_of(self, node_id)?;
        if provider.is_zero() {
            return Err(Error::NodeDoesNotExist(NodeDoesNotExist { node_id }));
        }
        let active = collection.is_active(self, node_id)?;
        Ok((provider, active))
    }

    fn fetch_rental(&self, rental_id: U256) -> Result<Rental, Error> {
        if rental_id.is_zero() || rental_id > self.rental_counter.get() {
            return Err(Error::RentalDoesNotExist(RentalDoesNotExist { rental_id }));
        }
        Ok(Rental {
            node_id: self.r_node_id.getter(rental_id).get(),
            plan_id: self.r_plan_id.getter(rental_id).get().to::<u8>(),
            renter: self.r_renter.getter(rental_id).get(),
            provider: self.r_provider.getter(rental_id).get(),
            price: self.r_price.getter(rental_id).get(),
            duration: self.r_duration.getter(rental_id).get(),
            status: self.r_status.getter(rental_id).get().to::<u8>(),
            start_deadline: self.r_start_deadline.getter(rental_id).get(),
            starts_at: self.r_starts_at.getter(rental_id).get(),
            expires_at: self.r_expires_at.getter(rental_id).get(),
            created_at: self.r_created_at.getter(rental_id).get(),
        })
    }

    #[inline]
    fn now(&self) -> U256 {
        U256::from(self.vm().block_timestamp())
    }

    fn grace_seconds(&self) -> u64 {
        #[cfg(test)]
        {
            let override_seconds = TEST_GRACE.load(std::sync::atomic::Ordering::SeqCst);
            if override_seconds != u64::MAX {
                return override_seconds;
            }
        }
        START_GRACE_SECONDS
    }

    fn duration_seconds(&self, snapshotted_duration: U256) -> U256 {
        #[cfg(test)]
        {
            let override_seconds = TEST_DURATION.load(std::sync::atomic::Ordering::SeqCst);
            if override_seconds != u64::MAX {
                return U256::from(override_seconds);
            }
        }
        snapshotted_duration
    }
}

fn is_non_terminal(status: u8) -> bool {
    status == STATUS_RESERVED || status == STATUS_ACTIVE
}

#[cfg(test)]
mod tests;
