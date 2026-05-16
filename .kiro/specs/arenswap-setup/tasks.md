# Implementation Plan: ArenSwap Setup

## Overview

Set up the ArenSwap project baseline across two sibling directories: install and wire the Web3 stack (Wagmi v2, Viem, RainbowKit) into the existing Next.js 16 frontend, then initialize a Foundry contracts project and scaffold the USDC-to-EURC swap contract with its test and deployment script.

## Tasks

- [x] 1. Install Web3 dependencies
  - Run `npm install wagmi@2.15.4 viem@2.31.3 @rainbow-me/rainbowkit@2.2.5 @tanstack/react-query@5.80.7` from inside `arenswap-frontend/`
  - Verify all four packages appear under `dependencies` (not `devDependencies`) in `package.json` with exact pinned versions — no `^`, `~`, or other semver range operators
  - Confirm the install exits with code 0 and produces no peer dependency conflict output
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Create Wagmi configuration module
  - Create `app/lib/wagmi.ts` in `arenswap-frontend/`
  - Add `'use client'` as the first line of the file
  - Define the `arcTestnet` custom chain using `defineChain` from `viem` with: id `5042002`, name `"Arc Testnet"`, native currency `{ name: "USD Coin", symbol: "USDC", decimals: 6 }`, RPC URL `https://rpc.testnet.arcscan.app`, block explorer URL `https://testnet.arcscan.app`
  - Export `wagmiConfig` created with `createConfig` from `wagmi`, using `chains: [arcTestnet]` and `transports: { [arcTestnet.id]: http('https://rpc.testnet.arcscan.app') }`
  - No `window`, `document`, or `localStorage` calls at module evaluation time
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 3. Create Web3Provider component
  - Create `app/providers/Web3Provider.tsx` in `arenswap-frontend/`
  - Add `'use client'` as the first line of the file
  - Import `QueryClient` and `QueryClientProvider` from `@tanstack/react-query`
  - Import `WagmiProvider` from `wagmi`
  - Import `RainbowKitProvider` and `coolTheme` from `@rainbow-me/rainbowkit`
  - Import `wagmiConfig` from `@/app/lib/wagmi`
  - Import `@rainbow-me/rainbowkit/styles.css` (must be in a Client Component to avoid Turbopack build errors)
  - Instantiate `queryClient` at module scope: `const queryClient = new QueryClient()`
  - Export a default `Web3Provider` function component accepting `children: React.ReactNode`
  - Nest providers in order: `QueryClientProvider` (outermost, `client={queryClient}`) → `WagmiProvider` (`config={wagmiConfig}`) → `RainbowKitProvider` (`theme={coolTheme()}`) → `{children}` (innermost)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 4. Integrate Web3Provider into root layout
  - Modify `app/layout.tsx` in `arenswap-frontend/`
  - Add `import Web3Provider from './providers/Web3Provider'` (do NOT add `'use client'` to this file)
  - Wrap `{children}` inside `<body>` with `<Web3Provider>{children}</Web3Provider>`
  - Preserve the `metadata` named export, `geistSans` with `--font-geist-sans`, and `geistMono` with `--font-geist-mono` unchanged
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 5. Checkpoint — verify frontend builds
  - Run `npm run build` inside `arenswap-frontend/` and confirm it exits with code 0 and no TypeScript or compiler errors
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Initialize Foundry contracts project
  - Run `forge init arenswap-contracts` from the parent directory `d:\` (so the new project lands at `d:\arenswap-contracts\`, a sibling of `arenswap-frontend\`)
  - Confirm the following directories exist and are non-empty after init: `src/`, `test/`, `script/`, `lib/`, `lib/forge-std/`
  - Confirm `foundry.toml` exists at the project root
  - Run `forge build` inside `arenswap-contracts/` and confirm it exits with code 0
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 7. Scaffold ArenSwap contract
  - Create `arenswap-contracts/src/ArenSwap.sol` (replacing the default `Counter.sol` if present)
  - File must begin with `// SPDX-License-Identifier: MIT` and `pragma solidity ^0.8.20;`
  - Define an inline `IERC20` interface with `transfer`, `transferFrom`, `approve`, and `balanceOf` signatures
  - Declare `address public immutable usdc` and `address public immutable eurc`, both set in the constructor
  - Declare `uint256 public swapRate` and `address public owner`
  - Implement `modifier onlyOwner()` that reverts with `"ArenSwap: caller is not the owner"`
  - Constructor accepts `(address _usdc, address _eurc)` and sets `usdc`, `eurc`, and `owner = msg.sender`
  - Implement `setSwapRate(uint256 newRate) external onlyOwner` that assigns `swapRate`
  - Implement `swap(uint256 usdcAmount) external` that reverts with `"ArenSwap: amount must be greater than zero"` when `usdcAmount == 0`, and contains a `// TODO:` comment describing the expected computation shape `eurcAmount = usdcAmount * swapRate`
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_

- [x] 8. Scaffold ArenSwap test file
  - Create `arenswap-contracts/test/ArenSwap.t.sol` (replacing the default `Counter.t.sol` if present)
  - File must begin with `// SPDX-License-Identifier: MIT` and `pragma solidity ^0.8.20;`
  - Import `"forge-std/Test.sol"` and `"../src/ArenSwap.sol"`
  - Define `contract ArenSwapTest is Test` with state variables: `ArenSwap public arenSwap`, `address public owner`, `address public usdc`, `address public eurc`
  - Implement `setUp()` with an empty body (stub for future initialization)
  - Implement `test_placeholder()` containing `assertTrue(true); // TODO: add real tests`
  - [ ]* 8.1 Write property test for non-owner access control (Property 1)
    - Add `testFuzz_setSwapRate_revertsForNonOwner(address caller, uint256 newRate)` to `ArenSwapTest`
    - Use `vm.assume(caller != owner)`, `vm.prank(caller)`, `vm.expectRevert("ArenSwap: caller is not the owner")`, then call `arenSwap.setSwapRate(newRate)`
    - Note: `setUp()` must deploy `ArenSwap` with mock addresses before this test can run — update `setUp()` accordingly when adding this test
    - **Property 1: Non-owner calls to owner-protected functions always revert**
    - **Validates: Requirements 6.7, 6.8**
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 9. Scaffold ArenSwap deployment script
  - Create `arenswap-contracts/script/ArenSwap.s.sol` (replacing the default `Counter.s.sol` if present)
  - File must begin with `// SPDX-License-Identifier: MIT` and `pragma solidity ^0.8.20;`
  - Import `"forge-std/Script.sol"` and `"../src/ArenSwap.sol"`
  - Define `contract ArenSwapScript is Script` with a `run() external` function
  - Inside `run()`: declare `address usdcAddress = address(0); // TODO: replace with actual USDC address`, `address eurcAddress = address(0); // TODO: replace with actual EURC address`, `uint256 initialSwapRate = 0; // TODO: replace with actual initial swap rate`
  - Call `vm.startBroadcast()`, then `new ArenSwap(usdcAddress, eurcAddress)`, then `vm.stopBroadcast()`
  - _Requirements: 8.1, 8.2, 8.3_

- [x] 10. Checkpoint — verify contracts project builds and tests pass
  - Run `forge build` inside `arenswap-contracts/` and confirm it exits with code 0 with no compiler errors
  - Run `forge test` inside `arenswap-contracts/` and confirm it exits with code 0
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Task 8.1 (the fuzz test) requires `setUp()` to deploy a live `ArenSwap` instance — the stub `setUp()` from task 8 must be filled in before the fuzz test will compile
- Each task references specific requirements for traceability
- Checkpoints (tasks 5 and 10) ensure incremental validation at natural boundaries
- The frontend tasks (1–4) and contracts tasks (6–9) are independent of each other and can be worked in parallel after task 1 completes
- Read `node_modules/next/dist/docs/` before modifying any Next.js files — this project uses Next.js 16 which may have breaking changes from earlier versions

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2", "6"] },
    { "id": 2, "tasks": ["3", "7"] },
    { "id": 3, "tasks": ["4", "8", "9"] },
    { "id": 4, "tasks": ["8.1"] }
  ]
}
```
