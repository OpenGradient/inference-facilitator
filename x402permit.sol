// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

/**
 * @title ISignatureTransfer
 * @notice Interface for Permit2's SignatureTransfer functionality
 * @dev Based on Uniswap's canonical Permit2 contract
 */
interface ISignatureTransfer {
    /**
     * @notice The token and amount details for a transfer signed in the permit transfer signature
     */
    struct TokenPermissions {
        // ERC20 token address
        address token;
        // the maximum amount that can be spent
        uint256 amount;
    }

    /**
     * @notice The signed permit message for a single token transfer
     */
    struct PermitTransferFrom {
        TokenPermissions permitted;
        // a unique value for every token owner's signature to prevent signature replays
        uint256 nonce;
        // deadline on the permit signature
        uint256 deadline;
    }

    /**
     * @notice Specifies the recipient address and amount for batched transfers.
     * @dev Recipients and amounts correspond to the index of the signed token permissions array.
     * @dev Reverts if the requested amount is greater than the permitted signed amount.
     */
    struct SignatureTransferDetails {
        // recipient address
        address to;
        // spender requested amount
        uint256 requestedAmount;
    }

    /**
     * @notice A map from token owner address and a caller specified word
     *         index to a bitmap. Used to set bits in the bitmap to prevent
     *         against signature replay protection
     * @dev Uses unordered nonces so that permit messages do not need to be
     *      spent in a certain order
     * @dev The mapping is indexed first by the token owner, then by an
     *      index specified in the nonce
     * @dev It returns a uint256 bitmap
     * @dev The index, or wordPosition is capped at type(uint248).max
     */
    function nonceBitmap(address, uint256) external view returns (uint256);

    /**
     * @notice Transfers a token using a signed permit message
     * @dev Reverts if the requested amount is greater than the permitted signed amount
     * @param permit The permit data signed over by the owner
     * @param owner The owner of the tokens to transfer
     * @param transferDetails The spender's requested transfer details for the permitted token
     * @param signature The signature to verify
     */
    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;

    /**
     * @notice Transfers a token using a signed permit message
     * @notice Includes extra data provided by the caller to verify
     *         signature over
     * @dev The witness type string must follow EIP712 ordering of nested
     *      structs and must include the TokenPermissions type definition
     * @dev Reverts if the requested amount is greater than the permitted
     *      signed amount
     * @param permit The permit data signed over by the owner
     * @param transferDetails The spender's requested transfer details for
     *        the permitted token
     * @param owner The owner of the tokens to transfer
     * @param witness Extra data to include when checking the user signature
     * @param witnessTypeString The EIP-712 type definition for remaining
     *        string stub of the typehash
     * @param signature The signature to verify
     */
    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";


/**
 * @title x402BasePermit2Proxy
 * @notice Abstract base contract for x402 payments using Permit2
 *
 * @dev This contract provides the shared logic for x402 payment proxies.
 *      It acts as the authorized spender in Permit2 signatures and uses the
 *      "witness" pattern to cryptographically bind the payment destination,
 *      preventing facilitators from redirecting funds.
 *
 *      The contract uses an initializer pattern instead of constructor parameters
 *      to ensure the same CREATE2 address across all EVM chains, regardless of
 *      the chain's Permit2 deployment address.
 *
 * @author x402 Protocol
 */
abstract contract x402BasePermit2Proxy is ReentrancyGuard {
    /// @notice The Permit2 contract address (set via initialize)
    ISignatureTransfer public PERMIT2;

    /// @notice Whether the contract has been initialized
    bool private _initialized;

    /// @notice EIP-712 type string for witness data
    /// @dev Must match the exact format expected by Permit2
    /// Types must be in ALPHABETICAL order after the primary type (TokenPermissions < Witness)
    string public constant WITNESS_TYPE_STRING =
        "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter,bytes extra)";

    /// @notice EIP-712 typehash for witness struct
    bytes32 public constant WITNESS_TYPEHASH = keccak256("Witness(address to,uint256 validAfter,bytes extra)");

    /// @notice Emitted when settle() completes successfully
    event Settled();

    /// @notice Emitted when settleWithPermit() completes successfully
    event SettledWithPermit();

    /// @notice Thrown when Permit2 address is zero
    error InvalidPermit2Address();

    /// @notice Thrown when initialize is called more than once
    error AlreadyInitialized();

    /// @notice Thrown when destination address is zero
    error InvalidDestination();

    /// @notice Thrown when payment is attempted before validAfter timestamp
    error PaymentTooEarly();

    /// @notice Thrown when owner address is zero
    error InvalidOwner();

    /**
     * @notice Witness data structure for payment authorization
     * @param to Destination address (immutable once signed)
     * @param validAfter Earliest timestamp when payment can be settled
     * @param extra Extensibility field for future use
     * @dev The upper time bound is enforced by Permit2's deadline field
     */
    struct Witness {
        address to;
        uint256 validAfter;
        bytes extra;
    }

    /**
     * @notice EIP-2612 permit parameters grouped to reduce stack depth
     * @param value Approval amount for Permit2
     * @param deadline Permit expiration timestamp
     * @param r ECDSA signature parameter
     * @param s ECDSA signature parameter
     * @param v ECDSA signature parameter
     */
    struct EIP2612Permit {
        uint256 value;
        uint256 deadline;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    /**
     * @notice Initializes the proxy with the Permit2 contract address
     * @param _permit2 Address of the Permit2 contract for this chain
     * @dev Can only be called once. Should be called immediately after deployment.
     *      Reverts if _permit2 is the zero address or if already initialized.
     */
    function initialize(
        address _permit2
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (_permit2 == address(0)) revert InvalidPermit2Address();
        _initialized = true;
        PERMIT2 = ISignatureTransfer(_permit2);
    }

    /**
     * @notice Internal settlement logic shared by all settlement functions
     * @dev Validates all parameters and executes the Permit2 transfer
     * @param permit The Permit2 transfer authorization
     * @param amount The amount to transfer
     * @param owner The token owner (payer)
     * @param witness The witness data containing destination and validity window
     * @param signature The payer's signature
     */
    function _settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        uint256 amount,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) internal {
        // Validate addresses
        if (owner == address(0)) revert InvalidOwner();
        if (witness.to == address(0)) revert InvalidDestination();

        // Validate time window (upper bound enforced by Permit2's deadline)
        if (block.timestamp < witness.validAfter) revert PaymentTooEarly();

        // Prepare transfer details with destination from witness
        ISignatureTransfer.SignatureTransferDetails memory transferDetails =
            ISignatureTransfer.SignatureTransferDetails({to: witness.to, requestedAmount: amount});

        // Reconstruct witness hash to enforce integrity
        bytes32 witnessHash =
            keccak256(abi.encode(WITNESS_TYPEHASH, witness.to, witness.validAfter, keccak256(witness.extra)));

        // Execute transfer via Permit2
        PERMIT2.permitWitnessTransferFrom(permit, transferDetails, owner, witnessHash, WITNESS_TYPE_STRING, signature);
    }

    /**
     * @notice Attempts to execute an EIP-2612 permit to approve Permit2
     * @dev Does not revert on failure because the approval might already exist
     *      or the token might not support EIP-2612
     * @param token The token address
     * @param owner The token owner
     * @param permit2612 The EIP-2612 permit parameters
     */
    function _executePermit(address token, address owner, EIP2612Permit calldata permit2612) internal {
        try IERC20Permit(token).permit(
            owner, address(PERMIT2), permit2612.value, permit2612.deadline, permit2612.v, permit2612.r, permit2612.s
        ) {
            // EIP-2612 permit succeeded
        } catch {
            // Permit2 settlement will fail if approval doesn't exist
        }
    }
}

/**
 * @title x402ExactPermit2Proxy
 * @notice Trustless proxy for x402 payments using Permit2 with exact amount transfers
 *
 * @dev This contract acts as the authorized spender in Permit2 signatures.
 *      It uses the "witness" pattern to cryptographically bind the payment destination,
 *      preventing facilitators from redirecting funds.
 *
 *      Unlike x402UptoPermit2Proxy, this contract always transfers the EXACT permitted
 *      amount, similar to EIP-3009's transferWithAuthorization behavior.
 *
 * @author x402 Protocol
 */
contract x402ExactPermit2Proxy is x402BasePermit2Proxy {
    /**
     * @notice Settles a payment using a Permit2 signature
     * @dev This is the standard settlement path when user has already approved Permit2.
     *      Always transfers the exact permitted amount.
     * @param permit The Permit2 transfer authorization
     * @param owner The token owner (payer)
     * @param witness The witness data containing destination and validity window
     * @param signature The payer's signature over the permit and witness
     */
    function settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external nonReentrant {
        _settle(permit, permit.permitted.amount, owner, witness, signature);
        emit Settled();
    }

    /**
     * @notice Settles a payment using both EIP-2612 permit and Permit2 signature
     * @dev Enables fully gasless flow for tokens supporting EIP-2612.
     *      First submits the EIP-2612 permit to approve Permit2, then settles.
     *      Always transfers the exact permitted amount.
     * @param permit2612 The EIP-2612 permit parameters
     * @param permit The Permit2 transfer authorization
     * @param owner The token owner (payer)
     * @param witness The witness data containing destination and validity window
     * @param signature The payer's signature over the permit and witness
     *
     * @dev This function will succeed even if the EIP-2612 permit fails,
     *      as long as the Permit2 approval already exists
     */
    function settleWithPermit(
        EIP2612Permit calldata permit2612,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external nonReentrant {
        _executePermit(permit.permitted.token, owner, permit2612);
        _settle(permit, permit.permitted.amount, owner, witness, signature);
        emit SettledWithPermit();
    }
}


/**
 * @title x402UptoPermit2Proxy
 * @notice Trustless proxy for x402 payments using Permit2 with variable amount transfers
 *
 * @dev Unlike x402ExactPermit2Proxy which always transfers the full permitted amount,
 *      this contract accepts an `actualAmount` parameter that must be <= permitted amount.
 *      This enables the "upto" scheme where a single signature covers multiple requests
 *      and only the accumulated cost is settled.
 *
 * @author x402 Protocol
 */
contract x402UptoPermit2Proxy is x402BasePermit2Proxy {

    /// @notice Thrown when actualAmount exceeds the permitted amount
    error AmountExceedsPermitted();

    /**
     * @notice Settles a payment for the actual accumulated amount
     * @dev The actualAmount must be <= permit.permitted.amount (the spend cap).
     *      The Permit2 signature covers the full cap, but only actualAmount is transferred.
     * @param permit The Permit2 transfer authorization (permitted.amount = spend cap)
     * @param owner The token owner (payer)
     * @param witness The witness data containing destination and validity window
     * @param signature The payer's signature over the permit and witness
     * @param actualAmount The actual amount to transfer (<= permitted amount)
     */
    function settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature,
        uint256 actualAmount
    ) external nonReentrant {
        if (actualAmount > permit.permitted.amount) revert AmountExceedsPermitted();
        _settle(permit, actualAmount, owner, witness, signature);
        emit Settled();
    }

    /**
     * @notice Settles with EIP-2612 permit + Permit2 for the actual accumulated amount
     * @param permit2612 The EIP-2612 permit parameters
     * @param permit The Permit2 transfer authorization
     * @param owner The token owner (payer)
     * @param witness The witness data containing destination and validity window
     * @param signature The payer's signature over the permit and witness
     * @param actualAmount The actual amount to transfer (<= permitted amount)
     */
    function settleWithPermit(
        EIP2612Permit calldata permit2612,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature,
        uint256 actualAmount
    ) external nonReentrant {
        if (actualAmount > permit.permitted.amount) revert AmountExceedsPermitted();
        _executePermit(permit.permitted.token, owner, permit2612);
        _settle(permit, actualAmount, owner, witness, signature);
        emit SettledWithPermit();
    }
}