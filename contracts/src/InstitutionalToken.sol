// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title InstitutionalToken
/// @notice Non-upgradeable ERC-20 with role-controlled minting, an immutable supply cap,
///         on-chain recipient eligibility, and replay-protected mint operation references.
/// @dev This contract implements ERC-20 only. It deliberately does NOT implement ERC-1400,
///      ERC-1404 or any other security-token standard, and makes no claim of doing so.
contract InstitutionalToken is ERC20Pausable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");

    /// @notice Immutable maximum total supply, in base units.
    uint256 public immutable supplyCap;

    uint8 private immutable _decimals;

    /// @notice Unix timestamp until which an address may receive tokens. 0 means not eligible.
    mapping(address account => uint64 eligibleUntil) public eligibleUntil;

    /// @notice Off-chain mint operation references already consumed by a successful mint.
    mapping(bytes32 operationReference => bool consumed) public referenceConsumed;

    event EligibilityUpdated(address indexed account, uint64 eligibleUntil);

    /// @notice Emitted on every successful referenced mint. Primary reconciliation signal.
    event MintExecuted(
        bytes32 indexed operationReference,
        address indexed recipient,
        uint256 amount,
        uint256 newTotalSupply
    );

    error InvalidRecipient(address recipient);
    error InvalidAmount();
    error InvalidOperationReference();
    error OperationReferenceAlreadyConsumed(bytes32 operationReference);
    error MintDeadlineExpired(uint64 deadline, uint256 blockTimestamp);
    error RecipientNotEligible(address recipient);
    error RecipientEligibilityExpired(address recipient, uint64 eligibleUntilTimestamp);
    error SupplyCapExceeded(uint256 requested, uint256 totalSupplyNow, uint256 cap);
    error InvalidSupplyCap();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 supplyCap_,
        address admin_,
        address minter_,
        address complianceOfficer_,
        address pauser_
    ) ERC20(name_, symbol_) {
        if (supplyCap_ == 0) revert InvalidSupplyCap();
        if (admin_ == address(0)) revert InvalidRecipient(admin_);

        supplyCap = supplyCap_;
        _decimals = decimals_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        if (minter_ != address(0)) _grantRole(MINTER_ROLE, minter_);
        if (complianceOfficer_ != address(0)) _grantRole(COMPLIANCE_ROLE, complianceOfficer_);
        if (pauser_ != address(0)) _grantRole(PAUSER_ROLE, pauser_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // --- compliance -------------------------------------------------------

    /// @param eligibleUntilTimestamp Unix seconds; 0 revokes eligibility immediately.
    function setEligibility(address account, uint64 eligibleUntilTimestamp)
        external
        onlyRole(COMPLIANCE_ROLE)
    {
        if (account == address(0)) revert InvalidRecipient(account);
        eligibleUntil[account] = eligibleUntilTimestamp;
        emit EligibilityUpdated(account, eligibleUntilTimestamp);
    }

    function isEligible(address account) public view returns (bool) {
        uint64 until = eligibleUntil[account];
        return until != 0 && until >= block.timestamp;
    }

    // --- pause ------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // --- minting ----------------------------------------------------------

    /// @notice Mint `amount` to `recipient`, exactly once per `operationReference`.
    /// @dev The reference binds an off-chain approved operation to a single on-chain effect,
    ///      so a rebroadcast or duplicated worker delivery can never mint twice.
    function mintWithReference(
        address recipient,
        uint256 amount,
        bytes32 operationReference,
        uint64 deadline
    ) external onlyRole(MINTER_ROLE) {
        // Explicit ordered validation keeps revert reasons deterministic for the
        // off-chain orchestrator, which maps them onto application error codes.
        _requireNotPaused();

        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient(recipient);
        if (amount == 0) revert InvalidAmount();
        if (operationReference == bytes32(0)) revert InvalidOperationReference();
        if (referenceConsumed[operationReference]) {
            revert OperationReferenceAlreadyConsumed(operationReference);
        }
        if (deadline < block.timestamp) revert MintDeadlineExpired(deadline, block.timestamp);

        uint64 until = eligibleUntil[recipient];
        if (until == 0) revert RecipientNotEligible(recipient);
        if (until < block.timestamp) revert RecipientEligibilityExpired(recipient, until);

        uint256 supplyNow = totalSupply();
        if (supplyNow + amount > supplyCap) revert SupplyCapExceeded(amount, supplyNow, supplyCap);

        referenceConsumed[operationReference] = true;
        _mint(recipient, amount);

        emit MintExecuted(operationReference, recipient, amount, totalSupply());
    }

    // --- transfer restrictions -------------------------------------------

    /// @dev Eligibility is enforced for every inbound movement, not only minting, so the
    ///      chain remains the authority on who may hold the asset.
    function _update(address from, address to, uint256 value) internal override(ERC20Pausable) {
        if (to != address(0) && !isEligible(to)) revert RecipientNotEligible(to);
        super._update(from, to, value);
    }
}
