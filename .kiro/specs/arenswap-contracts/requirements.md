# Requirements Document

## Introduction

This document covers the smart contract core logic phase for Arenswap — an onchain stablecoin FX swap platform on the Arc Network. The scope is three deliverables inside the existing Foundry project at `arenswap-contracts/`:

1. **`src/ArenSwap.sol`** — a reserve-based AMM with a fixed exchange rate, supporting bidirectional USDC↔EURC swaps, owner-managed liquidity, and emergency withdrawal.
2. **`test/ArenSwap.t.sol`** — comprehensive Foundry unit and fuzz tests covering happy paths, edge cases, access control, and arithmetic properties.
3. **`script/ArenSwap.s.sol`** — a deployment script ready for Arc Testnet broadcast using the real token addresses.

The existing scaffold (`ArenSwap.sol`) provides the structural skeleton: inline `IERC20` interface, immutable `usdc`/`eurc` addresses, `swapRate`, `owner`, `onlyOwner` modifier, stub `swap()`, and `setSwapRate()`. This spec replaces the stubs with production-ready logic.

---

## Glossary

- **ArenSwap**: The Solidity smart contract implementing the USDC-EURC reserve-based swap mechanism.
- **USDC**: USD Coin — ERC-20 token at `0x3600000000000000000000000000000000000000` on Arc Testnet, 6 decimals. Always accessed via the ERC-20 interface.
- **EURC**: Euro Coin — ERC-20 token at `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` on Arc Testnet, 6 decimals.
- **Reserve**: The balance of USDC or EURC held by the ArenSwap contract and available to fulfill swaps.
- **SwapRate**: A `uint256` state variable representing the number of EURC units returned per 1 USDC unit, scaled by `1e6`. For example, `921500` represents 0.9215 EURC per USDC.
- **Liquidity_Deposit**: An owner-initiated transfer of USDC or EURC tokens into the ArenSwap contract to increase reserves.
- **Owner**: The `address` that deployed the ArenSwap contract, stored in the `owner` state variable, with exclusive access to administrative functions.
- **Caller**: The `address` invoking a function on the ArenSwap contract (`msg.sender`).
- **Deployment_Script**: The Foundry `Script` contract at `script/ArenSwap.s.sol` used to deploy ArenSwap to Arc Testnet.
- **Mock_ERC20**: A minimal ERC-20 token contract used in tests to simulate USDC and EURC without requiring a live network.
- **IERC20**: The inline ERC-20 interface defined in `ArenSwap.sol` with `transfer`, `transferFrom`, `approve`, and `balanceOf` signatures.
- **Arc_Testnet**: The Arc Network test environment with Chain ID `5042002` and RPC `https://rpc.testnet.arc.network`.

---

## Requirements

### Requirement 1: Bidirectional Swap Functions

**User Story:** As a user, I want to swap USDC for EURC and EURC for USDC, so that I can exchange stablecoins at the current platform rate.

#### Acceptance Criteria

1. THE ArenSwap SHALL expose a `swapUSDCToEURC(uint256 usdcAmount)` external function that transfers `usdcAmount` of USDC from the Caller to the ArenSwap contract and transfers `eurcAmount` of EURC from the ArenSwap contract to the Caller, where `eurcAmount = usdcAmount * swapRate / 1e6`.
2. THE ArenSwap SHALL expose a `swapEURCToUSDC(uint256 eurcAmount)` external function that transfers `eurcAmount` of EURC from the Caller to the ArenSwap contract and transfers `usdcAmount` of USDC from the ArenSwap contract to the Caller, where `usdcAmount = eurcAmount * 1e6 / swapRate`.
3. WHEN `swapUSDCToEURC` is called, THE ArenSwap SHALL use `IERC20(usdc).transferFrom(msg.sender, address(this), usdcAmount)` to pull USDC from the Caller before transferring EURC out.
4. WHEN `swapEURCToUSDC` is called, THE ArenSwap SHALL use `IERC20(eurc).transferFrom(msg.sender, address(this), eurcAmount)` to pull EURC from the Caller before transferring USDC out.
5. IF `usdcAmount` is zero, THEN THE ArenSwap SHALL revert `swapUSDCToEURC` with the message `"ArenSwap: amount must be greater than zero"`.
6. IF `eurcAmount` is zero, THEN THE ArenSwap SHALL revert `swapEURCToUSDC` with the message `"ArenSwap: amount must be greater than zero"`.
7. IF the computed `eurcAmount` output of `swapUSDCToEURC` exceeds the ArenSwap contract's current EURC Reserve, THEN THE ArenSwap SHALL revert with the message `"ArenSwap: insufficient EURC reserve"`.
8. IF the computed `usdcAmount` output of `swapEURCToUSDC` exceeds the ArenSwap contract's current USDC Reserve, THEN THE ArenSwap SHALL revert with the message `"ArenSwap: insufficient USDC reserve"`.
9. IF the Caller has not approved the ArenSwap contract for at least `usdcAmount` of USDC before calling `swapUSDCToEURC`, THEN THE ArenSwap SHALL revert at the `transferFrom` call.
10. IF the Caller has not approved the ArenSwap contract for at least `eurcAmount` of EURC before calling `swapEURCToUSDC`, THEN THE ArenSwap SHALL revert at the `transferFrom` call.

---

### Requirement 2: Fixed Exchange Rate Arithmetic

**User Story:** As a user, I want swap output amounts to be computed precisely using integer arithmetic, so that I receive exactly the correct number of tokens with no rounding errors beyond the integer truncation inherent to Solidity.

#### Acceptance Criteria

1. THE ArenSwap SHALL compute the EURC output of `swapUSDCToEURC` as `usdcAmount * swapRate / 1e6` using integer arithmetic with no floating-point operations.
2. THE ArenSwap SHALL compute the USDC output of `swapEURCToUSDC` as `eurcAmount * 1e6 / swapRate` using integer arithmetic with no floating-point operations.
3. THE ArenSwap SHALL declare `swapRate` as a `uint256` scaled by `1e6`, where the value `921500` represents an exchange rate of 0.9215 EURC per USDC.
4. IF `swapRate` is zero, THEN THE ArenSwap SHALL revert any swap call with the message `"ArenSwap: swap rate not set"` before performing any token transfer.
5. FOR ALL valid `usdcAmount` values where `usdcAmount > 0` and `swapRate > 0`, THE ArenSwap SHALL produce a `eurcAmount` equal to `usdcAmount * swapRate / 1e6` (integer division) with no intermediate overflow for amounts up to `type(uint128).max`.

---

### Requirement 3: Liquidity Management

**User Story:** As the contract owner, I want to deposit USDC and EURC reserves into the contract, so that the contract has sufficient tokens to fulfill user swaps.

#### Acceptance Criteria

1. THE ArenSwap SHALL expose a `depositUSDC(uint256 amount)` external function protected by the `onlyOwner` modifier that transfers `amount` of USDC from the Owner to the ArenSwap contract using `IERC20(usdc).transferFrom(msg.sender, address(this), amount)`.
2. THE ArenSwap SHALL expose a `depositEURC(uint256 amount)` external function protected by the `onlyOwner` modifier that transfers `amount` of EURC from the Owner to the ArenSwap contract using `IERC20(eurc).transferFrom(msg.sender, address(this), amount)`.
3. IF a non-Owner address calls `depositUSDC`, THEN THE ArenSwap SHALL revert with the message `"ArenSwap: caller is not the owner"`.
4. IF a non-Owner address calls `depositEURC`, THEN THE ArenSwap SHALL revert with the message `"ArenSwap: caller is not the owner"`.
5. IF `amount` is zero, THEN THE ArenSwap SHALL revert `depositUSDC` and `depositEURC` with the message `"ArenSwap: amount must be greater than zero"`.
6. WHEN `depositUSDC` succeeds, THE ArenSwap SHALL emit a `LiquidityDeposited` event with parameters `(address indexed token, uint256 amount)` where `token` is the USDC address.
7. WHEN `depositEURC` succeeds, THE ArenSwap SHALL emit a `LiquidityDeposited` event with parameters `(address indexed token, uint256 amount)` where `token` is the EURC address.

---

### Requirement 4: Swap Events

**User Story:** As an integrator, I want the contract to emit events on every swap, so that I can index swap activity off-chain.

#### Acceptance Criteria

1. THE ArenSwap SHALL define a `Swapped` event with the signature `event Swapped(address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)`.
2. WHEN `swapUSDCToEURC` completes successfully, THE ArenSwap SHALL emit `Swapped` with `caller = msg.sender`, `tokenIn = usdc`, `tokenOut = eurc`, `amountIn = usdcAmount`, and `amountOut = eurcAmount`.
3. WHEN `swapEURCToUSDC` completes successfully, THE ArenSwap SHALL emit `Swapped` with `caller = msg.sender`, `tokenIn = eurc`, `tokenOut = usdc`, `amountIn = eurcAmount`, and `amountOut = usdcAmount`.

---

### Requirement 5: Emergency Withdrawal

**User Story:** As the contract owner, I want to withdraw USDC and EURC reserves from the contract, so that I can recover funds in an emergency or rebalance liquidity.

#### Acceptance Criteria

1. THE ArenSwap SHALL expose a `withdrawUSDC(uint256 amount)` external function protected by the `onlyOwner` modifier that transfers `amount` of USDC from the ArenSwap contract to the Owner using `IERC20(usdc).transfer(msg.sender, amount)`.
2. THE ArenSwap SHALL expose a `withdrawEURC(uint256 amount)` external function protected by the `onlyOwner` modifier that transfers `amount` of EURC from the ArenSwap contract to the Owner using `IERC20(eurc).transfer(msg.sender, amount)`.
3. IF a non-Owner address calls `withdrawUSDC`, THEN THE ArenSwap SHALL revert with the message `"ArenSwap: caller is not the owner"`.
4. IF a non-Owner address calls `withdrawEURC`, THEN THE ArenSwap SHALL revert with the message `"ArenSwap: caller is not the owner"`.
5. IF `amount` exceeds the ArenSwap contract's current USDC Reserve when `withdrawUSDC` is called, THEN THE ArenSwap SHALL revert at the `transfer` call.
6. IF `amount` exceeds the ArenSwap contract's current EURC Reserve when `withdrawEURC` is called, THEN THE ArenSwap SHALL revert at the `transfer` call.

---

### Requirement 6: Swap Rate Management

**User Story:** As the contract owner, I want to update the swap rate, so that I can keep the exchange rate aligned with market conditions.

#### Acceptance Criteria

1. THE ArenSwap SHALL retain the existing `setSwapRate(uint256 newRate)` function protected by the `onlyOwner` modifier that sets `swapRate` to `newRate`.
2. IF a non-Owner address calls `setSwapRate`, THEN THE ArenSwap SHALL revert with the message `"ArenSwap: caller is not the owner"`.
3. IF `newRate` is zero, THEN THE ArenSwap SHALL revert `setSwapRate` with the message `"ArenSwap: rate must be greater than zero"`.

---

### Requirement 7: Comprehensive Foundry Tests

**User Story:** As a developer, I want a comprehensive test suite in `test/ArenSwap.t.sol`, so that I can verify all swap logic, access control, and arithmetic properties before deployment.

#### Acceptance Criteria

1. THE test suite SHALL deploy a Mock_ERC20 contract in `setUp()` for both USDC and EURC, mint tokens to the test accounts, and deploy ArenSwap with the mock token addresses.
2. WHEN `swapUSDCToEURC` is called with a valid `usdcAmount` and sufficient EURC Reserve, THE test suite SHALL assert that the Caller's EURC balance increases by exactly `usdcAmount * swapRate / 1e6` and the Caller's USDC balance decreases by exactly `usdcAmount`.
3. WHEN `swapEURCToUSDC` is called with a valid `eurcAmount` and sufficient USDC Reserve, THE test suite SHALL assert that the Caller's USDC balance increases by exactly `eurcAmount * 1e6 / swapRate` and the Caller's EURC balance decreases by exactly `eurcAmount`.
4. THE test suite SHALL include a test that calls `swapUSDCToEURC(0)` and expects a revert with `"ArenSwap: amount must be greater than zero"`.
5. THE test suite SHALL include a test that calls `swapEURCToUSDC(0)` and expects a revert with `"ArenSwap: amount must be greater than zero"`.
6. THE test suite SHALL include a test that calls `swapUSDCToEURC` with an amount whose computed EURC output exceeds the EURC Reserve and expects a revert with `"ArenSwap: insufficient EURC reserve"`.
7. THE test suite SHALL include a test that calls `swapEURCToUSDC` with an amount whose computed USDC output exceeds the USDC Reserve and expects a revert with `"ArenSwap: insufficient USDC reserve"`.
8. THE test suite SHALL include a test that calls `swapUSDCToEURC` without prior ERC-20 approval and expects a revert.
9. THE test suite SHALL include a fuzz test `testFuzz_swapUSDCToEURC(uint256 usdcAmount)` that, for any `usdcAmount` in the range `[1, reserveSize]`, asserts the EURC output equals `usdcAmount * swapRate / 1e6`.
10. THE test suite SHALL include a fuzz test `testFuzz_swapRate_nonOwnerReverts(address caller, uint256 newRate)` that, for any `caller != owner`, asserts `setSwapRate` reverts with `"ArenSwap: caller is not the owner"`.
11. THE test suite SHALL include a fuzz test `testFuzz_depositUSDC_nonOwnerReverts(address caller, uint256 amount)` that, for any `caller != owner`, asserts `depositUSDC` reverts with `"ArenSwap: caller is not the owner"`.
12. THE test suite SHALL include a test that calls `swapUSDCToEURC` when `swapRate` is zero and expects a revert with `"ArenSwap: swap rate not set"`.
13. WHEN `forge test` is run inside `arenswap-contracts/`, THE test suite SHALL exit with code 0 and produce no compiler errors.

---

### Requirement 8: Swap Output Arithmetic Property

**User Story:** As a developer, I want a property-based test that verifies the swap output formula holds for all valid inputs, so that I can be confident the arithmetic is correct across the full input space.

#### Acceptance Criteria

1. FOR ALL `usdcAmount` values where `usdcAmount > 0` and `usdcAmount * swapRate` does not overflow `uint256`, THE ArenSwap SHALL produce a EURC output equal to `usdcAmount * swapRate / 1e6` (Solidity integer division).
2. FOR ALL `eurcAmount` values where `eurcAmount > 0` and `swapRate > 0`, THE ArenSwap SHALL produce a USDC output equal to `eurcAmount * 1e6 / swapRate` (Solidity integer division).
3. THE test suite SHALL implement these as Foundry fuzz tests using `vm.assume` to constrain inputs to the valid domain, with Foundry's fuzzer providing at least 256 runs per property.

---

### Requirement 9: Deployment Script

**User Story:** As a developer, I want a deployment script at `script/ArenSwap.s.sol` ready for Arc Testnet broadcast, so that I can deploy the contract with the correct token addresses and initial swap rate in a single command.

#### Acceptance Criteria

1. THE Deployment_Script SHALL import `forge-std/Script.sol` and `../src/ArenSwap.sol` and define a contract inheriting from `Script` with a `run()` external function.
2. THE Deployment_Script SHALL declare the USDC address as `address constant USDC = 0x3600000000000000000000000000000000000000` and the EURC address as `address constant EURC = 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`.
3. THE Deployment_Script `run()` function SHALL call `vm.startBroadcast()`, deploy a new `ArenSwap` contract passing `USDC` and `EURC` as constructor arguments, call `setSwapRate` on the deployed contract with an initial rate, and then call `vm.stopBroadcast()`.
4. THE Deployment_Script SHALL declare the initial swap rate as `uint256 constant INITIAL_SWAP_RATE = 921500` (representing 0.9215 EURC per USDC, i.e., 1 USDC = 0.9215 EURC).
5. WHEN `forge script script/ArenSwap.s.sol --rpc-url https://rpc.testnet.arc.network` is run without `--broadcast`, THE Deployment_Script SHALL compile without errors and simulate the deployment successfully.
