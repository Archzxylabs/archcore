// SPDX-License-Identifier: MIT OR Apache-2.0
//! ARCHcore `ComputeAsset` — non-transferable compute-node identity (ERC-721).
//!
//! A `ComputeAsset` token is minted once for a registered compute node and its
//! id is immutable for the lifetime of the node. The token cannot be
//! transferred, approved or delegated; ownership of a node token is therefore a
//! stable identity anchor that other ARCHcore contracts can key off.
//!
//! Two distinct privileges exist and must not be conflated:
//!
//! * **Token ownership** — the address that holds the node identity, reported
//!   by [`IErc721::owner_of`]. It can never be reassigned to a third party.
//! * **Contract administration** — the `Ownable` owner, the only account
//!   allowed to mint or burn node identities.
//!
//! Burning a node identity preserves the ability to reason about historical
//! tenancy: `RentalManager` snapshots the node operator at rental start, so a
//! deactivated node never invalidates the rentals it served.
//!
//! Burn is final. A retired node id is recorded in a tombstone and can never be
//! minted or re-enrolled again, because a re-mint would hand the same stable key
//! to a different operator and silently repoint downstream records. Use
//! [`ComputeAsset::node_retired`] to distinguish "never used" from "revoked".
//!
//! The ERC-721 *view* surface (`ownerOf`, `tokenURI`, `name`, `symbol`,
//! `balanceOf`) behaves per specification, while every mutating transfer path
//! reverts with [`Error::NodeNonTransferable`].

#![allow(
    clippy::module_name_repetitions,
    clippy::used_underscore_items,
    clippy::unreadable_literal
)]
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::{string::String, vec, vec::Vec};
use alloy_primitives::{aliases::B32, Address, U256};
use alloy_sol_types::sol;
use openzeppelin_stylus::access::ownable::{self, Ownable};
use openzeppelin_stylus::token::erc721::{
    self as erc721,
    extensions::{
        metadata::{self, IErc721Metadata},
        uri_storage::Erc721UriStorage,
    },
    receiver::{IErc721Receiver, RECEIVER_FN_SELECTOR},
    Erc721, IErc721,
};
use openzeppelin_stylus::utils::introspection::erc165::IErc165;
use stylus_sdk::{
    abi::Bytes,
    call::MethodError,
    prelude::*,
    storage::{StorageBool, StorageMap},
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Storage layout of the node identity contract.
#[storage]
#[entrypoint]
pub struct ComputeAsset {
    /// ERC-721 ledger. Balances and owners are retained so querying whether a
    /// node exists stays cheap; transfer bookkeeping is intentionally unused.
    pub erc721: Erc721,
    /// Collection-level metadata (`name`, `symbol`, base URI).
    pub metadata: metadata::Erc721Metadata,
    /// Per-node metadata URIs.
    pub uri_storage: Erc721UriStorage,
    /// Node ids that have ever been burned, mapped to `true`.
    ///
    /// [`Self::erc721`] alone cannot distinguish "never minted" from "minted and
    /// burned" — both report [`Address::ZERO`] as owner. This marker makes the
    /// distinction durable, so a retired node id can never be re-enrolled. It is
    /// only ever written to `true` and never cleared, which keeps the tombstone
    /// irreversible without adding a second privileged path.
    pub retired: StorageMap<U256, StorageBool>,
    /// Contract administrator — mints and burns node identities.
    pub ownable: Ownable,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

sol! {
    /// Revert data returned by every transfer path.
    #[derive(Debug)]
    error NodeNonTransferable();

    /// Revert data returned when enrolling a node id that was burned earlier.
    #[derive(Debug)]
    error NodeRetired();
}

/// Errors surfaced by [`ComputeAsset`].
///
/// The variants of the upstream `erc721::Error` and `ownable::Error` enums are
/// flattened into concrete [`sol!`] error types: `SolidityError` needs every
/// variant to implement `SolError`, which the upstream *enums* do not. This
/// mirrors how `Erc721Wrapper` composes its error surface, and keeps revert data
/// byte-identical to the upstream errors it forwards.
#[derive(SolidityError, Debug)]
pub enum Error {
    /// Any attempt to move, approve or delegate a node identity.
    NodeNonTransferable(NodeNonTransferable),
    /// The node id was burned before and cannot be re-enrolled.
    NodeRetired(NodeRetired),
    /// Indicates that an address can't be an owner, eg. [`Address::ZERO`] is a
    /// forbidden owner in [`Erc721`].
    Erc721InvalidOwner(erc721::ERC721InvalidOwner),
    /// Indicates a `token_id` whose `owner` is [`Address::ZERO`].
    Erc721NonexistentToken(erc721::ERC721NonexistentToken),
    /// Indicates an error related to the ownership over a particular token.
    Erc721IncorrectOwner(erc721::ERC721IncorrectOwner),
    /// Indicates a failure with the token `sender`.
    Erc721InvalidSender(erc721::ERC721InvalidSender),
    /// Indicates a failure with the token `receiver`.
    Erc721InvalidReceiver(erc721::ERC721InvalidReceiver),
    /// Indicates a failure with the token `receiver`, with the reason specified
    /// by it.
    Erc721InvalidReceiverWithReason(erc721::InvalidReceiverWithReason),
    /// Indicates a failure with the `operator`'s approval.
    Erc721InsufficientApproval(erc721::ERC721InsufficientApproval),
    /// Indicates a failure with the `approver` of a token to be approved.
    Erc721InvalidApprover(erc721::ERC721InvalidApprover),
    /// Indicates a failure with the `operator` to be approved.
    Erc721InvalidOperator(erc721::ERC721InvalidOperator),
    /// The caller account is not authorized to perform an operation.
    OwnableUnauthorizedAccount(ownable::OwnableUnauthorizedAccount),
    /// The owner is not a valid owner account, eg. [`Address::ZERO`].
    OwnableInvalidOwner(ownable::OwnableInvalidOwner),
}

impl From<erc721::Error> for Error {
    fn from(value: erc721::Error) -> Self {
        match value {
            erc721::Error::InvalidOwner(e) => Self::Erc721InvalidOwner(e),
            erc721::Error::NonexistentToken(e) => Self::Erc721NonexistentToken(e),
            erc721::Error::IncorrectOwner(e) => Self::Erc721IncorrectOwner(e),
            erc721::Error::InvalidSender(e) => Self::Erc721InvalidSender(e),
            erc721::Error::InvalidReceiver(e) => Self::Erc721InvalidReceiver(e),
            erc721::Error::InvalidReceiverWithReason(e) => Self::Erc721InvalidReceiverWithReason(e),
            erc721::Error::InsufficientApproval(e) => Self::Erc721InsufficientApproval(e),
            erc721::Error::InvalidApprover(e) => Self::Erc721InvalidApprover(e),
            erc721::Error::InvalidOperator(e) => Self::Erc721InvalidOperator(e),
        }
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

#[cfg(test)]
impl Error {
    /// Returns `true` when this error originates from an ERC-721 operation.
    fn is_erc721_variant(&self) -> bool {
        matches!(
            self,
            Self::Erc721InvalidOwner(_)
                | Self::Erc721NonexistentToken(_)
                | Self::Erc721IncorrectOwner(_)
                | Self::Erc721InvalidSender(_)
                | Self::Erc721InvalidReceiver(_)
                | Self::Erc721InvalidReceiverWithReason(_)
                | Self::Erc721InsufficientApproval(_)
                | Self::Erc721InvalidApprover(_)
                | Self::Erc721InvalidOperator(_)
        )
    }
}

impl MethodError for Error {
    fn encode(self) -> Vec<u8> {
        self.into()
    }
}

// ---------------------------------------------------------------------------
// Node administration
// ---------------------------------------------------------------------------

#[public]
#[implements(IErc721<Error = Error>, IErc721Metadata<Error = Error>, IErc165, IErc721Receiver)]
impl ComputeAsset {
    /// Deploy the collection.
    ///
    /// # Arguments
    ///
    /// * `name` — collection name surfaced through `IErc721Metadata::name`.
    /// * `symbol` — collection ticker surfaced through `IErc721Metadata::symbol`.
    /// * `owner` — contract administrator allowed to mint and burn nodes.
    #[constructor]
    pub fn constructor(
        &mut self,
        name: String,
        symbol: String,
        owner: Address,
    ) -> Result<(), Error> {
        self.ownable.constructor(owner)?;
        self.metadata.constructor(name, symbol);
        Ok(())
    }

    /// Mint a node identity. Only callable by the contract administrator.
    ///
    /// The `token_id` is chosen by the admin and is permanent: once minted a
    /// node id can never be transferred, and once burned it can never be
    /// enrolled again. See [`Self::burn_node`].
    ///
    /// # Errors
    ///
    /// * [`Error::OwnableUnauthorizedAccount`] — when the caller is not the
    ///   contract administrator.
    /// * [`Error::NodeRetired`] — when `token_id` was burned previously.
    /// * [`Error::Erc721InvalidSender`] — when `token_id` is already enrolled.
    /// * [`Error::Erc721InvalidReceiver`] — when `to` is [`Address::ZERO`].
    ///
    /// # Events
    ///
    /// * [`Transfer`].
    /// * `MetadataUpdate`.
    pub fn mint_node(&mut self, to: Address, token_id: U256, uri: String) -> Result<(), Error> {
        self.ownable.only_owner()?;
        // Burn is final. A retired id must stay unusable forever, otherwise a
        // re-mint would hand the same stable key to a second node operator and
        // silently repoint every downstream record keyed by `token_id`.
        self._require_not_retired(token_id)?;
        self.erc721._mint(to, token_id)?;
        self.uri_storage._set_token_uri(token_id, uri);
        Ok(())
    }

    /// Deactivate (burn) a node identity. Only callable by the contract
    /// administrator.
    ///
    /// Burning removes the identity from the ledger while leaving every
    /// downstream record that already snapshotted the node operator intact.
    ///
    /// Burn is terminal and irreversible. The id is recorded in
    /// [`Self::retired`], so it can never be minted or re-enrolled again — by
    /// the administrator or anybody else.
    ///
    /// # Errors
    ///
    /// * [`Error::OwnableUnauthorizedAccount`] — when the caller is not the
    ///   contract administrator.
    /// * [`Error::Erc721NonexistentToken`] — when `token_id` is not enrolled.
    ///
    /// # Events
    ///
    /// * [`Transfer`].
    pub fn burn_node(&mut self, token_id: U256) -> Result<(), Error> {
        self.ownable.only_owner()?;
        // Reverts when the token does not exist, so the marker is only ever
        // written for ids that were genuinely enrolled.
        self.erc721._burn(token_id)?;
        self.retired.setter(token_id).set(true);
        Ok(())
    }

    /// Returns `true` when the node identity exists (minted, not yet burned).
    pub fn node_exists(&self, token_id: U256) -> bool {
        self.erc721._owner_of(token_id) != Address::ZERO
    }

    /// Returns whether `node_id` is a live node identity.
    ///
    /// Frozen by the Integrator as node-identity state, not rental state:
    /// `isActive(nodeId) = nodeExists(nodeId) && !nodeRetired(nodeId)`. It reads
    /// the ERC-721 ledger and the retirement tombstone and adds no storage of its
    /// own, so the two cannot disagree. An unknown id and a burned id are both
    /// inactive; only a minted, unburned id is active.
    pub fn is_active(&self, node_id: U256) -> bool {
        self.node_exists(node_id) && !self.node_retired(node_id)
    }

    /// Returns the address that holds the node identity.
    ///
    /// Re-exported as an inherent method because `cargo stylus export-abi` only
    /// prints inherent `#[public]` methods, and `RentalManager` calls
    /// `ownerOf(uint256)` on the linked collection. Behaviour is identical to
    /// [`IErc721::owner_of`]: it reverts for an id that was never minted or has
    /// been burned. The trait implementation remains the ERC-165 `ownerOf`.
    ///
    /// # Errors
    ///
    /// * [`Error::Erc721NonexistentToken`] — when `token_id` is not enrolled.
    pub fn owner_of(&self, token_id: U256) -> Result<Address, Error> {
        Ok(self.erc721.owner_of(token_id)?)
    }

    /// Returns `true` when the node id has been burned and can never be
    /// re-enrolled.
    ///
    /// This is the authoritative answer to "was this id ever used?": it stays
    /// `true` after a burn, permanently, so integrators can reject a stale id
    /// instead of treating a nonexistent token as "available".
    pub fn node_retired(&self, token_id: U256) -> bool {
        self._is_retired(token_id)
    }

    /// Convenience accessor for the node metadata URI.
    ///
    /// Mirrors [`IErc721Metadata::token_uri`] under a protocol-specific name so
    /// integrators can distinguish node metadata reads from the generic
    /// ERC-721 surface.
    pub fn token_uri_for(&self, token_id: U256) -> Result<String, Error> {
        Ok(self
            .uri_storage
            .token_uri(token_id, &self.erc721, &self.metadata)?)
    }

    // -- Administration --------------------------------------------------------
    //
    // `Ownable` keeps its storage but its trait impl is deliberately not
    // re-exported here: these inherent wrappers keep the privileged surface
    // flat (a single, auditable enum of errors) instead of leaking
    // `ownable::Error`'s `Vec<u8>` failure path.
    //
    // `transfer_ownership` is the only sanctioned hand-off and always rejects
    // [`Address::ZERO`], so the role can never be abandoned by accident.
    // `renounce_ownership` exists so an operator can walk away, but doing so
    // freezes minting permanently — there is no second privileged path.

    /// Returns the contract administrator allowed to mint and burn nodes.
    pub fn owner(&self) -> Address {
        self.ownable.owner()
    }

    /// Transfers contract administration to `new_owner`. Only the owner.
    ///
    /// Administration is the power to enroll node ids and to retire them, so a
    /// transfer is the only way to move that power; it can never be granted to
    /// [`Address::ZERO`].
    ///
    /// # Errors
    ///
    /// * [`Error::OwnableInvalidOwner`] — when `new_owner` is [`Address::ZERO`].
    /// * [`Error::OwnableUnauthorizedAccount`] — when the caller is not the
    ///   administrator.
    ///
    /// # Events
    ///
    /// * `OwnershipTransferred`.
    pub fn transfer_ownership(&mut self, new_owner: Address) -> Result<(), Error> {
        self.ownable.transfer_ownership(new_owner)?;
        Ok(())
    }

    /// Permanently abandons contract administration. Only the owner.
    ///
    /// After a renounce there is no owner, so node enrollment and retirement
    /// are frozen for the lifetime of the deployment. Existing node identities
    /// remain readable and rentals already running are unaffected.
    ///
    /// # Errors
    ///
    /// * [`Error::OwnableUnauthorizedAccount`] — when the caller is not the
    ///   administrator.
    ///
    /// # Events
    ///
    /// * `OwnershipTransferred` with `new_owner == Address::ZERO`.
    pub fn renounce_ownership(&mut self) -> Result<(), Error> {
        self.ownable.renounce_ownership()?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
//
// Kept outside every `#[public]` block on purpose. Stylus strips a leading
// underscore and still exports the method, so a private helper placed in the
// public block would widen the ABI with an unintended `isRetired` /
// `requireNotRetired` surface.
// ---------------------------------------------------------------------------

impl ComputeAsset {
    /// Returns whether `token_id` is permanently retired.
    fn _is_retired(&self, token_id: U256) -> bool {
        self.retired.getter(token_id).get()
    }

    /// Reverts when `token_id` has been burned previously.
    ///
    /// # Errors
    ///
    /// * [`Error::NodeRetired`] — when `token_id` is retired.
    fn _require_not_retired(&self, token_id: U256) -> Result<(), Error> {
        if self._is_retired(token_id) {
            return Err(Error::NodeRetired(NodeRetired {}));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// IErc721 — identity is non-transferable
// ---------------------------------------------------------------------------

#[public]
impl IErc721 for ComputeAsset {
    type Error = Error;

    fn balance_of(&self, owner: Address) -> Result<U256, Self::Error> {
        Ok(self.erc721.balance_of(owner)?)
    }

    fn owner_of(&self, token_id: U256) -> Result<Address, Self::Error> {
        Ok(self.erc721.owner_of(token_id)?)
    }

    fn safe_transfer_from(
        &mut self,
        _from: Address,
        _to: Address,
        _token_id: U256,
    ) -> Result<(), Self::Error> {
        Err(NodeNonTransferable {}.into())
    }

    #[selector(name = "safeTransferFrom")]
    fn safe_transfer_from_with_data(
        &mut self,
        from: Address,
        to: Address,
        token_id: U256,
        _data: Bytes,
    ) -> Result<(), Self::Error> {
        self.safe_transfer_from(from, to, token_id)
    }

    fn transfer_from(
        &mut self,
        _from: Address,
        _to: Address,
        _token_id: U256,
    ) -> Result<(), Self::Error> {
        Err(NodeNonTransferable {}.into())
    }

    fn approve(&mut self, _to: Address, _token_id: U256) -> Result<(), Self::Error> {
        Err(NodeNonTransferable {}.into())
    }

    fn set_approval_for_all(
        &mut self,
        _operator: Address,
        _approved: bool,
    ) -> Result<(), Self::Error> {
        Err(NodeNonTransferable {}.into())
    }

    fn get_approved(&self, _token_id: U256) -> Result<Address, Self::Error> {
        Err(NodeNonTransferable {}.into())
    }

    fn is_approved_for_all(&self, owner: Address, operator: Address) -> bool {
        self.erc721.is_approved_for_all(owner, operator)
    }
}

// ---------------------------------------------------------------------------
// IErc721Metadata
// ---------------------------------------------------------------------------

#[public]
impl IErc721Metadata for ComputeAsset {
    type Error = Error;

    fn name(&self) -> String {
        self.metadata.name()
    }

    fn symbol(&self) -> String {
        self.metadata.symbol()
    }

    #[selector(name = "tokenURI")]
    fn token_uri(&self, token_id: U256) -> Result<String, Self::Error> {
        Ok(self
            .uri_storage
            .token_uri(token_id, &self.erc721, &self.metadata)?)
    }
}

// ---------------------------------------------------------------------------
// IErc165
// ---------------------------------------------------------------------------

#[public]
impl IErc165 for ComputeAsset {
    fn supports_interface(&self, interface_id: B32) -> bool {
        <ComputeAsset as IErc721>::interface_id() == interface_id
            || <ComputeAsset as IErc721Metadata>::interface_id() == interface_id
            || <ComputeAsset as IErc721Receiver>::interface_id() == interface_id
            || <ComputeAsset as IErc165>::interface_id() == interface_id
    }
}

// ---------------------------------------------------------------------------
// IErc721Receiver — the contract holds no foreign tokens of its own, so
// receipt always accepts. Provided for ERC-165 completeness and for future
// escrow integrations that may deposit node identities into the collection.
// ---------------------------------------------------------------------------

#[public]
impl IErc721Receiver for ComputeAsset {
    #[selector(name = "onERC721Received")]
    fn on_erc721_received(
        &mut self,
        _operator: Address,
        _from: Address,
        _token_id: U256,
        _data: Bytes,
    ) -> Result<B32, Vec<u8>> {
        Ok(RECEIVER_FN_SELECTOR)
    }
}

#[cfg(test)]
mod tests;
