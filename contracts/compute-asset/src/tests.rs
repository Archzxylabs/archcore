//! Unit tests for `ComputeAsset`.
use alloy_primitives::{aliases::B32, uint, Address, U256};
use motsu::prelude::*;
use openzeppelin_stylus::access::ownable;
use openzeppelin_stylus::token::erc721::{IErc721, Transfer};
use openzeppelin_stylus::utils::introspection::erc165::IErc165;

use super::*;

const NAME: &str = "ARCHcore Compute Node";
const SYMBOL: &str = "ARCHN";
const TOKEN_URI: &str = "node-0001.json";

const TOKEN_ID: U256 = uint!(1_U256);
const OTHER_TOKEN_ID: U256 = uint!(2_U256);

fn init(contract: &Contract<ComputeAsset>, owner: Address) {
    contract
        .sender(owner)
        .constructor(NAME.into(), SYMBOL.into(), owner)
        .expect("should initialize the collection");
}

fn mint(contract: &Contract<ComputeAsset>, owner: Address, to: Address, token_id: U256) {
    contract
        .sender(owner)
        .mint_node(to, token_id, TOKEN_URI.into())
        .expect("should mint node identity");
}

#[motsu::test]
fn constructor_hands_administration_to_owner(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);

    // No external `owner()` accessor is exposed; minting is the only privileged
    // path, so assert that administration actually sits with `alice`.
    mint(&contract, alice, alice, TOKEN_ID);
    assert_eq!(contract.sender(alice).owner_of(TOKEN_ID).unwrap(), alice);

    contract.assert_emitted(&ownable::OwnershipTransferred {
        previous_owner: Address::ZERO,
        new_owner: alice,
    });
}

#[motsu::test]
fn constructor_rejects_zero_owner(contract: Contract<ComputeAsset>, alice: Address) {
    let err = contract
        .sender(alice)
        .constructor(NAME.into(), SYMBOL.into(), Address::ZERO)
        .motsu_expect_err("should revert on zero owner");

    assert!(matches!(err, Error::OwnableInvalidOwner(_)));
}

#[motsu::test]
fn exposes_collection_metadata(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);

    assert_eq!(contract.sender(alice).name(), NAME);
    assert_eq!(contract.sender(alice).symbol(), SYMBOL);
}

#[motsu::test]
fn mint_registers_identity(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);

    mint(&contract, alice, alice, TOKEN_ID);

    assert!(contract.sender(alice).node_exists(TOKEN_ID));
    assert_eq!(contract.sender(alice).owner_of(TOKEN_ID).unwrap(), alice);
    assert_eq!(
        contract.sender(alice).balance_of(alice).unwrap(),
        uint!(1_U256)
    );
    assert_eq!(
        contract.sender(alice).token_uri_for(TOKEN_ID).unwrap(),
        TOKEN_URI
    );
    assert_eq!(
        contract.sender(alice).token_uri(TOKEN_ID).unwrap(),
        TOKEN_URI
    );

    contract.assert_emitted(&Transfer {
        from: Address::ZERO,
        to: alice,
        token_id: TOKEN_ID,
    });
}

#[motsu::test]
fn mint_reverts_for_non_owner(contract: Contract<ComputeAsset>, alice: Address, bob: Address) {
    init(&contract, alice);

    let err = contract
        .sender(bob)
        .mint_node(bob, TOKEN_ID, TOKEN_URI.into())
        .motsu_expect_err("should revert for non-owner");

    assert!(matches!(err, Error::OwnableUnauthorizedAccount(_)));
    assert!(!contract.sender(bob).node_exists(TOKEN_ID));
}

#[motsu::test]
fn mint_reverts_for_invalid_recipient(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);

    let err = contract
        .sender(alice)
        .mint_node(Address::ZERO, TOKEN_ID, TOKEN_URI.into())
        .motsu_expect_err("should revert on zero recipient");

    assert!(err.is_erc721_variant());
    assert!(!contract.sender(alice).node_exists(TOKEN_ID));
}

#[motsu::test]
fn mint_reverts_for_already_minted_token(
    contract: Contract<ComputeAsset>,
    alice: Address,
    bob: Address,
) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);

    let err = contract
        .sender(alice)
        .mint_node(bob, TOKEN_ID, TOKEN_URI.into())
        .motsu_expect_err("should revert on duplicate token id");

    assert!(err.is_erc721_variant());
}

#[motsu::test]
fn burn_removes_identity(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);

    contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .expect("should burn node identity");

    assert!(!contract.sender(alice).node_exists(TOKEN_ID));
    assert_eq!(
        contract.sender(alice).balance_of(alice).unwrap(),
        U256::ZERO
    );
    let err = contract
        .sender(alice)
        .owner_of(TOKEN_ID)
        .motsu_expect_err("should revert for burned token");
    assert!(err.is_erc721_variant());

    contract.assert_emitted(&Transfer {
        from: alice,
        to: Address::ZERO,
        token_id: TOKEN_ID,
    });
}

#[motsu::test]
fn burn_reverts_for_non_owner(contract: Contract<ComputeAsset>, alice: Address, bob: Address) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);

    let err = contract
        .sender(bob)
        .burn_node(TOKEN_ID)
        .motsu_expect_err("should revert for non-owner");

    assert!(matches!(err, Error::OwnableUnauthorizedAccount(_)));
    assert!(contract.sender(bob).node_exists(TOKEN_ID));
}

#[motsu::test]
fn burn_reverts_for_nonexistent_token(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);

    let err = contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .motsu_expect_err("should revert for unknown token id");

    assert!(err.is_erc721_variant());
}

#[motsu::test]
fn is_active_tracks_node_identity(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);

    // Never minted: inactive.
    assert!(!contract.sender(alice).is_active(TOKEN_ID));

    mint(&contract, alice, alice, TOKEN_ID);

    // Minted and not retired: active.
    assert!(contract.sender(alice).is_active(TOKEN_ID));
    // A different, unknown id stays inactive.
    assert!(!contract.sender(alice).is_active(OTHER_TOKEN_ID));

    contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .motsu_expect("should burn node identity");

    // Burned and retired: inactive, and it stays that way.
    assert!(!contract.sender(alice).is_active(TOKEN_ID));
    assert!(contract.sender(alice).node_retired(TOKEN_ID));
}

#[motsu::test]
fn node_exists_reports_unknown_ids(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);

    assert!(!contract.sender(alice).node_exists(TOKEN_ID));

    mint(&contract, alice, alice, TOKEN_ID);

    assert!(contract.sender(alice).node_exists(TOKEN_ID));
    assert!(!contract.sender(alice).node_exists(OTHER_TOKEN_ID));
}

#[motsu::test]
fn views_revert_for_unknown_token(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);

    let err = contract
        .sender(alice)
        .owner_of(TOKEN_ID)
        .motsu_expect_err("should revert for unknown token id");
    assert!(err.is_erc721_variant());

    let err = contract
        .sender(alice)
        .token_uri(TOKEN_ID)
        .motsu_expect_err("should revert for unknown token id");
    assert!(err.is_erc721_variant());

    let err = contract
        .sender(alice)
        .token_uri_for(TOKEN_ID)
        .motsu_expect_err("should revert for unknown token id");
    assert!(err.is_erc721_variant());
}

#[motsu::test]
fn transfers_are_disabled(contract: Contract<ComputeAsset>, alice: Address, bob: Address) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);

    let err = contract
        .sender(alice)
        .transfer_from(alice, bob, TOKEN_ID)
        .motsu_expect_err("transfer_from should revert");
    assert!(matches!(err, Error::NodeNonTransferable(_)));

    let err = contract
        .sender(alice)
        .safe_transfer_from(alice, bob, TOKEN_ID)
        .motsu_expect_err("safe_transfer_from should revert");
    assert!(matches!(err, Error::NodeNonTransferable(_)));

    let err = contract
        .sender(alice)
        .safe_transfer_from_with_data(alice, bob, TOKEN_ID, Bytes(vec![]))
        .motsu_expect_err("safe_transfer_from_with_data should revert");
    assert!(matches!(err, Error::NodeNonTransferable(_)));

    assert_eq!(contract.sender(alice).owner_of(TOKEN_ID).unwrap(), alice);
    assert_eq!(contract.sender(alice).balance_of(bob).unwrap(), U256::ZERO);
}

#[motsu::test]
fn approvals_are_disabled(contract: Contract<ComputeAsset>, alice: Address, bob: Address) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);

    let err = contract
        .sender(alice)
        .approve(bob, TOKEN_ID)
        .motsu_expect_err("approve should revert");
    assert!(matches!(err, Error::NodeNonTransferable(_)));

    let err = contract
        .sender(alice)
        .set_approval_for_all(bob, true)
        .motsu_expect_err("set_approval_for_all should revert");
    assert!(matches!(err, Error::NodeNonTransferable(_)));

    let err = contract
        .sender(alice)
        .get_approved(TOKEN_ID)
        .motsu_expect_err("get_approved should revert");
    assert!(matches!(err, Error::NodeNonTransferable(_)));

    assert!(!contract.sender(alice).is_approved_for_all(alice, bob));
}

#[motsu::test]
fn supports_erc165_interfaces(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);

    assert!(contract
        .sender(alice)
        .supports_interface(<ComputeAsset as IErc721>::interface_id()));
    assert!(contract
        .sender(alice)
        .supports_interface(<ComputeAsset as IErc721Metadata>::interface_id()));
    assert!(contract
        .sender(alice)
        .supports_interface(<ComputeAsset as IErc165>::interface_id()));
    assert!(!contract.sender(alice).supports_interface(B32::ZERO));
    // `onERC721Received` really is dispatchable, so reporting it is truthful
    // rather than aspirational.
    assert!(contract
        .sender(alice)
        .supports_interface(<ComputeAsset as IErc721Receiver>::interface_id()));
    // Interfaces that are deliberately *not* implemented must stay negative,
    // otherwise a caller would route to a selector that reverts.
    //
    // `IOwnable` is the honest test: administration is exposed as three
    // inherent wrappers (`owner`, `transferOwnership`, `renounceOwnership`)
    // rather than through `Ownable`'s trait impl, so the id is not claimed.
    assert!(!contract
        .sender(alice)
        .supports_interface(<Ownable as ownable::IOwnable>::interface_id()));
}

#[motsu::test]
fn admin_can_transfer_administration(
    contract: Contract<ComputeAsset>,
    alice: Address,
    bob: Address,
) {
    init(&contract, alice);
    assert_eq!(contract.sender(alice).owner(), alice);

    contract
        .sender(alice)
        .transfer_ownership(bob)
        .motsu_expect("owner may hand administration over");

    assert_eq!(contract.sender(alice).owner(), bob);
    contract.assert_emitted(&ownable::OwnershipTransferred {
        previous_owner: alice,
        new_owner: bob,
    });

    // The departed admin loses minting; the new admin gains it.
    let err = contract
        .sender(alice)
        .mint_node(alice, TOKEN_ID, TOKEN_URI.into())
        .motsu_expect_err("previous owner must lose enrollment rights");
    assert!(matches!(err, Error::OwnableUnauthorizedAccount(_)));

    contract
        .sender(bob)
        .mint_node(bob, TOKEN_ID, TOKEN_URI.into())
        .motsu_expect("new owner must gain enrollment rights");
    assert_eq!(contract.sender(bob).owner_of(TOKEN_ID).unwrap(), bob);
}

#[motsu::test]
fn transfer_of_administration_rejects_zero_address(
    contract: Contract<ComputeAsset>,
    alice: Address,
) {
    init(&contract, alice);

    let err = contract
        .sender(alice)
        .transfer_ownership(Address::ZERO)
        .motsu_expect_err("administration must never be abandoned by transfer");

    assert!(matches!(err, Error::OwnableInvalidOwner(_)));
    // Administration stays put, so enrollment is still possible.
    assert_eq!(contract.sender(alice).owner(), alice);
    mint(&contract, alice, alice, TOKEN_ID);
}

#[motsu::test]
fn transfer_of_administration_rejects_non_owner(
    contract: Contract<ComputeAsset>,
    alice: Address,
    bob: Address,
) {
    init(&contract, alice);

    let err = contract
        .sender(bob)
        .transfer_ownership(bob)
        .motsu_expect_err("non-owner must not be able to seize administration");

    assert!(matches!(err, Error::OwnableUnauthorizedAccount(_)));
    assert_eq!(contract.sender(alice).owner(), alice);
}

#[motsu::test]
fn renouncing_administration_freezes_enrollment_permanently(
    contract: Contract<ComputeAsset>,
    alice: Address,
    bob: Address,
) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);

    contract
        .sender(alice)
        .renounce_ownership()
        .motsu_expect("owner may renounce administration");

    assert_eq!(contract.sender(alice).owner(), Address::ZERO);
    contract.assert_emitted(&ownable::OwnershipTransferred {
        previous_owner: alice,
        new_owner: Address::ZERO,
    });

    // Nobody — not the former owner, not anybody else — may mint or burn from
    // here on. This is the ceiling on the privileged surface.
    for caller in [alice, bob] {
        let mint_err = contract
            .sender(caller)
            .mint_node(caller, OTHER_TOKEN_ID, TOKEN_URI.into())
            .motsu_expect_err("minting must be frozen after renouncement");
        assert!(matches!(mint_err, Error::OwnableUnauthorizedAccount(_)));

        let burn_err = contract
            .sender(caller)
            .burn_node(TOKEN_ID)
            .motsu_expect_err("burning must be frozen after renouncement");
        assert!(matches!(burn_err, Error::OwnableUnauthorizedAccount(_)));
    }

    // State stays readable, so running rentals are not disturbed.
    assert!(contract.sender(alice).node_exists(TOKEN_ID));
    assert!(!contract.sender(alice).node_retired(TOKEN_ID));
    assert!(!contract.sender(alice).node_exists(OTHER_TOKEN_ID));
}

#[motsu::test]
fn renounce_of_administration_rejects_non_owner(
    contract: Contract<ComputeAsset>,
    alice: Address,
    bob: Address,
) {
    init(&contract, alice);

    let err = contract
        .sender(bob)
        .renounce_ownership()
        .motsu_expect_err("only the administrator may renounce");

    assert!(matches!(err, Error::OwnableUnauthorizedAccount(_)));
    assert_eq!(contract.sender(alice).owner(), alice);
}

#[motsu::test]
fn on_erc721_received_returns_selector(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);

    let selector = contract
        .sender(alice)
        .on_erc721_received(alice, Address::ZERO, TOKEN_ID, Bytes(vec![]))
        .expect("should accept node identity");

    assert_eq!(selector, RECEIVER_FN_SELECTOR);
}

#[motsu::test]
fn burn_clears_ledger_state(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);

    contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .motsu_expect("should burn node identity");

    assert!(!contract.sender(alice).node_exists(TOKEN_ID));
    assert_eq!(
        contract.sender(alice).balance_of(alice).unwrap(),
        U256::ZERO
    );
    assert!(contract.sender(alice).owner_of(TOKEN_ID).is_err());
}

#[motsu::test]
fn burn_emits_transfer_to_zero(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);

    contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .motsu_expect("should burn node identity");

    contract.assert_emitted(&Transfer {
        from: alice,
        to: Address::ZERO,
        token_id: TOKEN_ID,
    });
}

#[motsu::test]
fn mark_burn_is_final(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);

    assert!(!contract.sender(alice).node_retired(TOKEN_ID));

    contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .motsu_expect("should burn node identity");

    assert!(contract.sender(alice).node_retired(TOKEN_ID));
    assert!(!contract.sender(alice).node_exists(TOKEN_ID));
}

#[motsu::test]
fn retired_id_cannot_be_reminted(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);
    contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .motsu_expect("should burn node identity");

    let err = contract
        .sender(alice)
        .mint_node(alice, TOKEN_ID, TOKEN_URI.into())
        .motsu_expect_err("should revert on retired token id");

    assert!(matches!(err, Error::NodeRetired(_)));
    // The id must stay unusable, not merely fail loudly and expose partial
    // ledger state for a fresh enroll.
    assert!(!contract.sender(alice).node_exists(TOKEN_ID));
    assert!(contract.sender(alice).node_retired(TOKEN_ID));
}

#[motsu::test]
fn retired_id_cannot_be_reminted_to_another_node(
    contract: Contract<ComputeAsset>,
    alice: Address,
    bob: Address,
) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);
    contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .motsu_expect("should burn node identity");

    // The administrator handing a retired id to a different operator is exactly
    // the repointing attack this tombstone prevents.
    let err = contract
        .sender(alice)
        .mint_node(bob, TOKEN_ID, TOKEN_URI.into())
        .motsu_expect_err("should revert on retired token id");

    assert!(matches!(err, Error::NodeRetired(_)));
    assert_eq!(contract.sender(alice).balance_of(bob).unwrap(), U256::ZERO);
    assert!(contract.sender(alice).node_retired(TOKEN_ID));
}

#[motsu::test]
fn remint_of_retired_id_emits_no_transfer(
    contract: Contract<ComputeAsset>,
    alice: Address,
    bob: Address,
) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);
    contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .motsu_expect("should burn node identity");

    assert!(contract
        .sender(alice)
        .mint_node(bob, TOKEN_ID, TOKEN_URI.into())
        .is_err());

    // `bob` was never a legitimate recipient of `TOKEN_ID`, so a Mint naming
    // them could only come from the reverted attempt leaking an event.
    assert!(
        !contract.emitted(&Transfer {
            from: Address::ZERO,
            to: bob,
            token_id: TOKEN_ID,
        }),
        "a reverted enroll must not leave a Mint event behind"
    );
    assert_eq!(contract.sender(alice).balance_of(bob).unwrap(), U256::ZERO);
}

#[motsu::test]
fn fresh_token_id_is_not_retired(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);
    contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .motsu_expect("should burn node identity");

    // The tombstone is per-id and must not block enrolling a genuinely new node.
    mint(&contract, alice, alice, OTHER_TOKEN_ID);

    assert!(contract.sender(alice).node_exists(OTHER_TOKEN_ID));
    assert!(!contract.sender(alice).node_retired(OTHER_TOKEN_ID));
    assert_eq!(
        contract.sender(alice).owner_of(OTHER_TOKEN_ID).unwrap(),
        alice
    );
}

#[motsu::test]
fn retire_view_is_stable_after_reenrollment(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);
    contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .motsu_expect("should burn node identity");

    assert!(contract.sender(alice).node_retired(TOKEN_ID));
    // Repeated reads must not mutate the tombstone and must stay `true`.
    assert!(contract.sender(alice).node_retired(TOKEN_ID));
    assert!(!contract
        .sender(alice)
        .mint_node(alice, TOKEN_ID, TOKEN_URI.into())
        .is_ok());
    assert!(contract.sender(alice).node_retired(TOKEN_ID));
}

#[motsu::test]
fn re_burning_retired_id_stays_reverted(contract: Contract<ComputeAsset>, alice: Address) {
    init(&contract, alice);
    mint(&contract, alice, alice, TOKEN_ID);
    contract
        .sender(alice)
        .burn_node(TOKEN_ID)
        .motsu_expect("should burn node identity");

    // Re-burning an already retired id is a no-op on the marker but must not
    // reintroduce the id onto the ledger.
    assert!(contract.sender(alice).burn_node(TOKEN_ID).is_err());
    assert!(contract.sender(alice).node_retired(TOKEN_ID));
    assert!(!contract.sender(alice).node_exists(TOKEN_ID));
}
