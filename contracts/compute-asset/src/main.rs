// SPDX-License-Identifier: MIT OR Apache-2.0
//! Host-side entrypoint that lets `cargo stylus export-abi` print the full
//! Solidity interface for `ComputeAsset`.
//!
//! This file exists because the `export-abi` feature is what turns the
//! `#[entrypoint]` struct into a [`main`] that writes the ABI to stdout. The
//! macro cannot inject a binary target, so the crate has to declare one; without
//! it `cargo stylus export-abi` fails with "a bin target must be available for
//! `cargo run`".
//!
//! This is plumbing only: it carries no contract logic and is never part of the
//! `wasm32-unknown-unknown` release blob.

#[cfg(feature = "export-abi")]
fn main() {
    compute_asset::print_from_args();
}

#[cfg(not(feature = "export-abi"))]
fn main() {}
