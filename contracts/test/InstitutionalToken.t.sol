// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {InstitutionalToken} from "../src/InstitutionalToken.sol";

contract InstitutionalTokenTest is Test {
    InstitutionalToken internal token;

    address internal admin = address(0xA11CE);
    address internal minter = address(0xB0B);
    address internal compliance = address(0xC0FFEE);
    address internal pauser = address(0xDEAD1);
    address internal investor = address(0x1111);
    address internal outsider = address(0x2222);

    uint256 internal constant CAP = 1_000_000e18;

    event MintExecuted(
        bytes32 indexed operationReference,
        address indexed recipient,
        uint256 amount,
        uint256 newTotalSupply
    );
    event EligibilityUpdated(address indexed account, uint64 eligibleUntil);

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new InstitutionalToken("Demo Fund Token", "DFT", 18, CAP, admin, minter, compliance, pauser);
    }

    function _makeEligible(address account, uint64 until) internal {
        vm.prank(compliance);
        token.setEligibility(account, until);
    }

    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 1 hours);
    }

    // --- construction ------------------------------------------------------

    function test_Constructor_SetsMetadataRolesAndCap() public view {
        assertEq(token.name(), "Demo Fund Token");
        assertEq(token.symbol(), "DFT");
        assertEq(token.decimals(), 18);
        assertEq(token.supplyCap(), CAP);
        assertTrue(token.hasRole(token.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(token.hasRole(token.MINTER_ROLE(), minter));
        assertTrue(token.hasRole(token.COMPLIANCE_ROLE(), compliance));
        assertTrue(token.hasRole(token.PAUSER_ROLE(), pauser));
        assertEq(token.totalSupply(), 0);
    }

    function test_Constructor_RevertsOnZeroCap() public {
        vm.expectRevert(InstitutionalToken.InvalidSupplyCap.selector);
        new InstitutionalToken("X", "X", 18, 0, admin, minter, compliance, pauser);
    }

    function test_Constructor_RevertsOnZeroAdmin() public {
        vm.expectRevert(abi.encodeWithSelector(InstitutionalToken.InvalidRecipient.selector, address(0)));
        new InstitutionalToken("X", "X", 18, CAP, address(0), minter, compliance, pauser);
    }

    // --- eligibility -------------------------------------------------------

    function test_SetEligibility_EmitsEventAndFlipsIsEligible() public {
        uint64 until = uint64(block.timestamp + 30 days);
        vm.expectEmit(true, false, false, true);
        emit EligibilityUpdated(investor, until);
        vm.prank(compliance);
        token.setEligibility(investor, until);

        assertTrue(token.isEligible(investor));
        assertEq(token.eligibleUntil(investor), until);
    }

    function test_SetEligibility_RevertsForNonComplianceRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, token.COMPLIANCE_ROLE()
            )
        );
        vm.prank(outsider);
        token.setEligibility(investor, uint64(block.timestamp + 1 days));
    }

    function test_SetEligibility_ZeroRevokes() public {
        _makeEligible(investor, uint64(block.timestamp + 1 days));
        assertTrue(token.isEligible(investor));
        _makeEligible(investor, 0);
        assertFalse(token.isEligible(investor));
    }

    // --- happy path --------------------------------------------------------

    function test_MintWithReference_HappyPath() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        bytes32 ref = keccak256("op-1");
        uint256 amount = 250e18;

        vm.expectEmit(true, true, false, true);
        emit MintExecuted(ref, investor, amount, amount);

        vm.prank(minter);
        token.mintWithReference(investor, amount, ref, _deadline());

        assertEq(token.balanceOf(investor), amount);
        assertEq(token.totalSupply(), amount);
        assertTrue(token.referenceConsumed(ref));
    }

    function test_MintWithReference_DistinctReferencesAccumulate() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        vm.startPrank(minter);
        token.mintWithReference(investor, 100e18, keccak256("op-1"), _deadline());
        token.mintWithReference(investor, 50e18, keccak256("op-2"), _deadline());
        vm.stopPrank();

        assertEq(token.balanceOf(investor), 150e18);
        assertEq(token.totalSupply(), 150e18);
    }

    function test_MintWithReference_ExactlyAtCapSucceeds() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        vm.prank(minter);
        token.mintWithReference(investor, CAP, keccak256("op-cap"), _deadline());
        assertEq(token.totalSupply(), CAP);
    }

    function test_MintWithReference_AtExactDeadlineSucceeds() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        vm.prank(minter);
        token.mintWithReference(investor, 1e18, keccak256("op-edge"), uint64(block.timestamp));
        assertEq(token.balanceOf(investor), 1e18);
    }

    function test_MintWithReference_AtExactEligibilityExpirySucceeds() public {
        _makeEligible(investor, uint64(block.timestamp));
        vm.prank(minter);
        token.mintWithReference(investor, 1e18, keccak256("op-edge-2"), _deadline());
        assertEq(token.balanceOf(investor), 1e18);
    }

    // --- adversarial -------------------------------------------------------

    function test_MintWithReference_RevertsForUnauthorizedCaller() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, token.MINTER_ROLE()
            )
        );
        vm.prank(outsider);
        token.mintWithReference(investor, 1e18, keccak256("op-x"), _deadline());
    }

    function test_MintWithReference_RevertsForAdminWithoutMinterRole() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, token.MINTER_ROLE()
            )
        );
        vm.prank(admin);
        token.mintWithReference(investor, 1e18, keccak256("op-x"), _deadline());
    }

    function test_MintWithReference_RevertsWhenPaused() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        vm.prank(pauser);
        token.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(minter);
        token.mintWithReference(investor, 1e18, keccak256("op-paused"), _deadline());
    }

    function test_MintWithReference_SucceedsAfterUnpause() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        vm.prank(pauser);
        token.pause();
        vm.prank(pauser);
        token.unpause();

        vm.prank(minter);
        token.mintWithReference(investor, 1e18, keccak256("op-unpaused"), _deadline());
        assertEq(token.balanceOf(investor), 1e18);
    }

    function test_Pause_RevertsForNonPauser() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, token.PAUSER_ROLE()
            )
        );
        vm.prank(outsider);
        token.pause();
    }

    function test_MintWithReference_RevertsForIneligibleRecipient() public {
        vm.expectRevert(
            abi.encodeWithSelector(InstitutionalToken.RecipientNotEligible.selector, investor)
        );
        vm.prank(minter);
        token.mintWithReference(investor, 1e18, keccak256("op-inelig"), _deadline());
    }

    function test_MintWithReference_RevertsForExpiredEligibility() public {
        uint64 until = uint64(block.timestamp + 10);
        _makeEligible(investor, until);
        vm.warp(block.timestamp + 11);

        vm.expectRevert(
            abi.encodeWithSelector(
                InstitutionalToken.RecipientEligibilityExpired.selector, investor, until
            )
        );
        vm.prank(minter);
        token.mintWithReference(investor, 1e18, keccak256("op-expired"), _deadline());
    }

    function test_MintWithReference_RevertsForExpiredDeadline() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        uint64 deadline = uint64(block.timestamp - 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                InstitutionalToken.MintDeadlineExpired.selector, deadline, block.timestamp
            )
        );
        vm.prank(minter);
        token.mintWithReference(investor, 1e18, keccak256("op-deadline"), deadline);
    }

    function test_MintWithReference_RevertsForReusedReference() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        bytes32 ref = keccak256("op-replay");

        vm.prank(minter);
        token.mintWithReference(investor, 10e18, ref, _deadline());

        vm.expectRevert(
            abi.encodeWithSelector(InstitutionalToken.OperationReferenceAlreadyConsumed.selector, ref)
        );
        vm.prank(minter);
        token.mintWithReference(investor, 10e18, ref, _deadline());

        assertEq(token.totalSupply(), 10e18);
    }

    function test_MintWithReference_RevertsForReusedReferenceEvenWithDifferentParams() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        _makeEligible(outsider, uint64(block.timestamp + 30 days));
        bytes32 ref = keccak256("op-replay-2");

        vm.prank(minter);
        token.mintWithReference(investor, 10e18, ref, _deadline());

        vm.expectRevert(
            abi.encodeWithSelector(InstitutionalToken.OperationReferenceAlreadyConsumed.selector, ref)
        );
        vm.prank(minter);
        token.mintWithReference(outsider, 999e18, ref, _deadline());
    }

    function test_MintWithReference_RevertsForZeroReference() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        vm.expectRevert(InstitutionalToken.InvalidOperationReference.selector);
        vm.prank(minter);
        token.mintWithReference(investor, 1e18, bytes32(0), _deadline());
    }

    function test_MintWithReference_RevertsWhenSupplyCapExceeded() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        vm.prank(minter);
        token.mintWithReference(investor, CAP - 1e18, keccak256("op-a"), _deadline());

        vm.expectRevert(
            abi.encodeWithSelector(
                InstitutionalToken.SupplyCapExceeded.selector, 2e18, CAP - 1e18, CAP
            )
        );
        vm.prank(minter);
        token.mintWithReference(investor, 2e18, keccak256("op-b"), _deadline());
    }

    function test_MintWithReference_RevertsForZeroRecipient() public {
        vm.expectRevert(
            abi.encodeWithSelector(InstitutionalToken.InvalidRecipient.selector, address(0))
        );
        vm.prank(minter);
        token.mintWithReference(address(0), 1e18, keccak256("op-zero"), _deadline());
    }

    function test_MintWithReference_RevertsForTokenItselfAsRecipient() public {
        vm.expectRevert(
            abi.encodeWithSelector(InstitutionalToken.InvalidRecipient.selector, address(token))
        );
        vm.prank(minter);
        token.mintWithReference(address(token), 1e18, keccak256("op-self"), _deadline());
    }

    function test_MintWithReference_RevertsForZeroAmount() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        vm.expectRevert(InstitutionalToken.InvalidAmount.selector);
        vm.prank(minter);
        token.mintWithReference(investor, 0, keccak256("op-amt"), _deadline());
    }

    function test_MintWithReference_ReferenceNotConsumedOnRevert() public {
        bytes32 ref = keccak256("op-failed");
        vm.prank(minter);
        vm.expectRevert(
            abi.encodeWithSelector(InstitutionalToken.RecipientNotEligible.selector, investor)
        );
        token.mintWithReference(investor, 1e18, ref, _deadline());

        assertFalse(token.referenceConsumed(ref));

        _makeEligible(investor, uint64(block.timestamp + 1 days));
        vm.prank(minter);
        token.mintWithReference(investor, 1e18, ref, _deadline());
        assertTrue(token.referenceConsumed(ref));
    }

    // --- transfer restrictions --------------------------------------------

    function test_Transfer_RevertsWhenRecipientIneligible() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        vm.prank(minter);
        token.mintWithReference(investor, 100e18, keccak256("op-t"), _deadline());

        vm.expectRevert(
            abi.encodeWithSelector(InstitutionalToken.RecipientNotEligible.selector, outsider)
        );
        vm.prank(investor);
        token.transfer(outsider, 1e18);
    }

    function test_Transfer_SucceedsBetweenEligibleHolders() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        _makeEligible(outsider, uint64(block.timestamp + 30 days));
        vm.prank(minter);
        token.mintWithReference(investor, 100e18, keccak256("op-t2"), _deadline());

        vm.prank(investor);
        token.transfer(outsider, 40e18);
        assertEq(token.balanceOf(outsider), 40e18);
        assertEq(token.balanceOf(investor), 60e18);
    }

    function test_Transfer_RevertsWhenPaused() public {
        _makeEligible(investor, uint64(block.timestamp + 30 days));
        _makeEligible(outsider, uint64(block.timestamp + 30 days));
        vm.prank(minter);
        token.mintWithReference(investor, 100e18, keccak256("op-t3"), _deadline());

        vm.prank(pauser);
        token.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(investor);
        token.transfer(outsider, 1e18);
    }

    // --- fuzz --------------------------------------------------------------

    function testFuzz_MintWithReference_NeverExceedsCap(uint256 amount) public {
        amount = bound(amount, 1, CAP * 2);
        _makeEligible(investor, uint64(block.timestamp + 30 days));

        vm.prank(minter);
        if (amount > CAP) {
            vm.expectRevert(
                abi.encodeWithSelector(InstitutionalToken.SupplyCapExceeded.selector, amount, 0, CAP)
            );
            token.mintWithReference(investor, amount, keccak256("op-fuzz"), _deadline());
            assertEq(token.totalSupply(), 0);
        } else {
            token.mintWithReference(investor, amount, keccak256("op-fuzz"), _deadline());
            assertEq(token.totalSupply(), amount);
            assertLe(token.totalSupply(), CAP);
        }
    }

    function testFuzz_ReferenceIsSingleUse(bytes32 ref) public {
        vm.assume(ref != bytes32(0));
        _makeEligible(investor, uint64(block.timestamp + 30 days));

        vm.prank(minter);
        token.mintWithReference(investor, 1e18, ref, _deadline());

        vm.expectRevert(
            abi.encodeWithSelector(InstitutionalToken.OperationReferenceAlreadyConsumed.selector, ref)
        );
        vm.prank(minter);
        token.mintWithReference(investor, 1e18, ref, _deadline());
    }
}
