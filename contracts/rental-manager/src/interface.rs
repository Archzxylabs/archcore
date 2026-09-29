// SPDX-License-Identifier: MIT OR Apache-2.0
//! ABI surface and typed access to the external `ComputeAsset` contract.

use alloy_primitives::Address;
use alloy_sol_types::sol;
use openzeppelin_stylus::token::erc721::IErc721;
use stylus_sdk::{call::MethodError, prelude::*};

/// `IErc721` entrypoints bound to the concrete [`Error`] surface of this crate.
///
/// A fresh alias is required because a Solidity interface method already
/// inherits the generic parameter of its definition, so it cannot be parametrised
/// again in an inherent implementation. The alias flattens the generic
/// `IErc721MethodError` to a single concrete [`Error`].
pub trait IErc721Methods {
    /// Reads the address that currently holds `token_id`.
    fn owner_of(&self, token_id: U256) -> Result<Address, MethodError>;
}

impl IErc721Methods for IErc721 {
    fn owner_of(&self, token_id: U256) -> Result<Address, MethodError> {
        IErc721::owner_of(self, token_id)
    }
}

sol! {
    /// Events raised by `RentalManager`.
    event NodeRented(
        address indexed renter,
        uint256 indexed node_id,
        uint256 indexed rental_id,
        uint256 expiry
    );
}

/// Indicates that the requested node is not a registered `ComputeAsset`.
#[derive(SolidityError, Debug)]
pub enum Error {
    /// Missing or misconfigured `ComputeAsset` address.
    ComputeAssetNotSet(ComputeAssetNotSet),
    /// The requested node has no registered identity.
    NodeNotRegistered(NodeNotRegistered),
}

sol! {
    /// The `ComputeAsset` contract has not been configured.
    #[derive(Debug)]
    error ComputeAssetNotSet();
    /// The requested node id has no registered identity.
    #[derive(Debug)]
    error NodeNotRegistered(uint256 node_id);
}
