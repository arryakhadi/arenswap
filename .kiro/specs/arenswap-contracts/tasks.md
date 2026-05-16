# Implementation Plan: ArenSwap Contracts

## Overview

Implement the ArenSwap smart contract core logic inside the existing Foundry project at `arenswap-contracts/`. The work proceeds in dependency order: mock first, then the production contract, then tests, then the deployment script — with `foundry.toml` configuration running in parallel with the mock. Two forge checkpoints validate compilation and test passage before the workflow is complete.

## Tasks

- [x] 1. Configure foundry.toml
  - Add `solc = "0.8.20"` to `[profile.default]` in `foundry.toml`
  - Add a `[fuzz]` section with `runs = 256`
  - Final file should match the structure shown in the design document
  - _Requirements: 8.3, 9.5_

- [x] 2. Create MockERC20 test mock
  - [x] 2.1 Create `test/mocks/MockERC20.sol`
    - Declare `pragma solidity ^0.8.20` and `// SPDX-License-Identifier: MIT`
    - Add `name`, `symbol`, `decimals` public state variables
    - Add `balanceOf` and `allowance` mappings
    - Implement constructor setting `name`, `symbol`, `decimals`
    - Implement `mint(address to, uint256 amount)` — increments `balanceOf[to]`
    - Implement `approve(address spender, uint256 amount)` — sets allowance, returns `true`
    - Implement `transfer(address to, uint256 amount)` — checks balance, moves funds, returns `true`
    - Implement `transferFrom(address from, address to, uint256 amount)` — checks balance and allowance, decrements both, moves funds, returns `true`
    - No `totalSupply`, no events — only what ArenSwap calls
    - _Requirements: 7.1_

- [x] 3. Implement `src/ArenSwap.sol` production logic
  - [x] 3.1 Add events and update `setSwapRate`
    - Add `event Swapped(address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)` after the `IERC20` interface
    - Add `event LiquidityDeposited(address indexed token, uint256 amount)` after `Swapped`
    - In `setSwapRate`, add `require(newRate > 0, "ArenSwap: rate must be greater than zero")` before the assignment
    - _Requirements: 4.1, 6.3_

  - [x] 3.2 Implement `swapUSDCToEURC`
    - Remove the existing stub `swap()` function
    - Add `function swapUSDCToEURC(uint256 usdcAmount) external`
    - Step 1: `require(usdcAmount > 0, "ArenSwap: amount must be greater than zero")`
    - Step 2: `require(swapRate > 0, "ArenSwap: swap rate not set")`
    - Step 3: compute `uint256 eurcOut = usdcAmount * swapRate / 1e6`
    - Step 4: `require(IERC20(eurc).balanceOf(address(this)) >= eurcOut, "ArenSwap: insufficient EURC reserve")`
    - Step 5: `IERC20(usdc).transferFrom(msg.sender, address(this), usdcAmount)`
    - Step 6: `IERC20(eurc).transfer(msg.sender, eurcOut)`
    - Step 7: `emit Swapped(msg.sender, usdc, eurc, usdcAmount, eurcOut)`
    - _Requirements: 1.1, 1.3, 1.5, 1.7, 1.9, 2.1, 2.4, 2.5, 4.2_

  - [x] 3.3 Implement `swapEURCToUSDC`
    - Add `function swapEURCToUSDC(uint256 eurcAmount) external`
    - Step 1: `require(eurcAmount > 0, "ArenSwap: amount must be greater than zero")`
    - Step 2: `require(swapRate > 0, "ArenSwap: swap rate not set")`
    - Step 3: compute `uint256 usdcOut = eurcAmount * 1e6 / swapRate`
    - Step 4: `require(IERC20(usdc).balanceOf(address(this)) >= usdcOut, "ArenSwap: insufficient USDC reserve")`
    - Step 5: `IERC20(eurc).transferFrom(msg.sender, address(this), eurcAmount)`
    - Step 6: `IERC20(usdc).transfer(msg.sender, usdcOut)`
    - Step 7: `emit Swapped(msg.sender, eurc, usdc, eurcAmount, usdcOut)`
    - _Requirements: 1.2, 1.4, 1.6, 1.8, 1.10, 2.2, 2.4, 4.3_

  - [x] 3.4 Implement `depositUSDC` and `depositEURC`
    - Add `function depositUSDC(uint256 amount) external onlyOwner`
      - `require(amount > 0, "ArenSwap: amount must be greater than zero")`
      - `IERC20(usdc).transferFrom(msg.sender, address(this), amount)`
      - `emit LiquidityDeposited(usdc, amount)`
    - Add `function depositEURC(uint256 amount) external onlyOwner` — symmetric, using `eurc`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 3.5 Implement `withdrawUSDC` and `withdrawEURC`
    - Add `function withdrawUSDC(uint256 amount) external onlyOwner`
      - `IERC20(usdc).transfer(msg.sender, amount)` — ERC-20 reverts on insufficient balance
    - Add `function withdrawEURC(uint256 amount) external onlyOwner` — symmetric, using `eurc`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 4. Update `script/ArenSwap.s.sol`
  - Replace any TODO placeholders with the real Arc Testnet addresses:
    - `address constant USDC = 0x3600000000000000000000000000000000000000`
    - `address constant EURC = 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`
  - Declare `uint256 constant INITIAL_SWAP_RATE = 921500`
  - Ensure `run()` calls `vm.startBroadcast()`, deploys `new ArenSwap(USDC, EURC)`, calls `arenSwap.setSwapRate(INITIAL_SWAP_RATE)`, then `vm.stopBroadcast()`
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 5. Checkpoint — forge build
  - Run `wsl bash -c 'cd /mnt/d/arenswap-contracts && forge build'`
  - Exit code must be 0 with no compiler errors
  - Fix any compilation issues before proceeding to tests
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Write `test/ArenSwap.t.sol`
  - [x] 6.1 Write test file scaffold and `setUp`
    - Import `forge-std/Test.sol`, `../src/ArenSwap.sol`, `./mocks/MockERC20.sol`
    - Declare `ArenSwapTest is Test` with fields: `arenSwap`, `mockUsdc`, `mockEurc`, `owner`, `user`
    - Declare constants: `SWAP_RATE = 921_500`, `RESERVE_SIZE = 1_000_000e6`
    - In `setUp`: set `owner = address(this)`, `user = makeAddr("user")`
    - Deploy `mockUsdc` and `mockEurc` as `MockERC20` instances
    - Deploy `arenSwap = new ArenSwap(address(mockUsdc), address(mockEurc))`
    - Mint `RESERVE_SIZE` of each token directly to `address(arenSwap)`
    - Call `arenSwap.setSwapRate(SWAP_RATE)`
    - Mint `RESERVE_SIZE` of each token to `user`
    - `vm.prank(user)` + `mockUsdc.approve(address(arenSwap), type(uint256).max)`
    - `vm.prank(user)` + `mockEurc.approve(address(arenSwap), type(uint256).max)`
    - _Requirements: 7.1_

  - [x] 6.2 Write happy-path unit tests
    - `test_swapUSDCToEURC_happyPath`: assert EURC balance increases by `usdcAmount * SWAP_RATE / 1e6` and USDC balance decreases by `usdcAmount`
    - `test_swapEURCToUSDC_happyPath`: assert USDC balance increases by `eurcAmount * 1e6 / SWAP_RATE` and EURC balance decreases by `eurcAmount`
    - _Requirements: 7.2, 7.3_

  - [x] 6.3 Write revert unit tests
    - `test_swapUSDCToEURC_zeroAmount_reverts`: `vm.expectRevert("ArenSwap: amount must be greater than zero")`, call `swapUSDCToEURC(0)`
    - `test_swapEURCToUSDC_zeroAmount_reverts`: same pattern for `swapEURCToUSDC(0)`
    - `test_swapUSDCToEURC_insufficientReserve_reverts`: `vm.expectRevert("ArenSwap: insufficient EURC reserve")`, call with amount whose output exceeds reserve
    - `test_swapEURCToUSDC_insufficientReserve_reverts`: `vm.expectRevert("ArenSwap: insufficient USDC reserve")`, call with amount whose output exceeds reserve
    - `test_swapUSDCToEURC_noApproval_reverts`: revoke approval with `approve(address(arenSwap), 0)`, expect revert at `transferFrom`
    - `test_swapUSDCToEURC_zeroRate_reverts`: deploy a fresh `ArenSwap` with rate unset (0), `vm.expectRevert("ArenSwap: swap rate not set")`, call `swapUSDCToEURC`
    - `test_setSwapRate_zeroRate_reverts`: `vm.expectRevert("ArenSwap: rate must be greater than zero")`, call `setSwapRate(0)`
    - _Requirements: 7.4, 7.5, 7.6, 7.7, 7.8, 7.12_

  - [x] 6.4 Write event emission unit tests
    - `test_swapUSDCToEURC_emitsSwapped`: use `vm.expectEmit` to assert `Swapped(user, usdc, eurc, usdcAmount, eurcOut)` is emitted
    - `test_swapEURCToUSDC_emitsSwapped`: assert `Swapped(user, eurc, usdc, eurcAmount, usdcOut)` is emitted
    - `test_depositUSDC_emitsLiquidityDeposited`: owner calls `depositUSDC`, assert `LiquidityDeposited(usdc, amount)` emitted
    - `test_depositEURC_emitsLiquidityDeposited`: owner calls `depositEURC`, assert `LiquidityDeposited(eurc, amount)` emitted
    - _Requirements: 4.2, 4.3, 3.6, 3.7_

  - [ ]* 6.5 Write fuzz test for Property 1 — USDC→EURC output formula
    - **Property 1: USDC→EURC output formula**
    - **Validates: Requirements 1.1, 2.1, 2.5, 8.1**
    - Function: `testFuzz_swapUSDCToEURC_outputFormula(uint256 usdcAmount)`
    - `vm.assume(usdcAmount > 0)` and `vm.assume(usdcAmount <= type(uint128).max)`
    - Compute `expectedEurcOut = usdcAmount * SWAP_RATE / 1e6`, `vm.assume(expectedEurcOut <= RESERVE_SIZE)`
    - Snapshot balances before, `vm.prank(user)`, call `swapUSDCToEURC(usdcAmount)`, assert exact balance deltas

  - [ ]* 6.6 Write fuzz test for Property 2 — EURC→USDC output formula
    - **Property 2: EURC→USDC output formula**
    - **Validates: Requirements 1.2, 2.2, 8.2**
    - Function: `testFuzz_swapEURCToUSDC_outputFormula(uint256 eurcAmount)`
    - `vm.assume(eurcAmount > 0)` and `vm.assume(eurcAmount <= type(uint128).max)`
    - Compute `expectedUsdcOut = eurcAmount * 1e6 / SWAP_RATE`, `vm.assume(expectedUsdcOut <= RESERVE_SIZE)`
    - Snapshot balances before, `vm.prank(user)`, call `swapEURCToUSDC(eurcAmount)`, assert exact balance deltas

  - [ ]* 6.7 Write fuzz test for Property 3 — non-owner always reverts
    - **Property 3: Non-owner calls to owner-protected functions always revert**
    - **Validates: Requirements 3.3, 3.4, 5.3, 5.4, 6.2**
    - Function: `testFuzz_ownerProtected_nonOwnerReverts(address caller, uint256 amount, uint256 newRate)`
    - `vm.assume(caller != owner)`, `vm.assume(amount > 0)`, `vm.assume(newRate > 0)`
    - `vm.startPrank(caller)`, then for each of `setSwapRate`, `depositUSDC`, `depositEURC`, `withdrawUSDC`, `withdrawEURC`: `vm.expectRevert("ArenSwap: caller is not the owner")` then call
    - `vm.stopPrank()`

- [x] 7. Final checkpoint — forge test
  - Run `wsl bash -c 'cd /mnt/d/arenswap-contracts && forge test -v'`
  - All tests must pass, exit code must be 0
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Checkpoints (tasks 5 and 7) validate compilation and test passage incrementally
- Property tests (6.5, 6.6, 6.7) validate universal correctness across the full input space with 256 fuzz runs each
- Unit tests (6.2–6.4) validate specific examples, edge cases, and event emission
- Task 1 (`foundry.toml`) is independent and can run in parallel with task 2 (`MockERC20`)
- Task 4 (`script/ArenSwap.s.sol`) depends only on task 3 and can proceed as soon as the contract compiles

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2.1"] },
    { "id": 1, "tasks": ["3.1"] },
    { "id": 2, "tasks": ["3.2", "3.3"] },
    { "id": 3, "tasks": ["3.4", "3.5"] },
    { "id": 4, "tasks": ["4"] },
    { "id": 5, "tasks": ["6.1"] },
    { "id": 6, "tasks": ["6.2", "6.3", "6.4"] },
    { "id": 7, "tasks": ["6.5", "6.6", "6.7"] }
  ]
}
```
