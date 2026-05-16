# Implementation Plan: Swap Integration

## Overview

Wire the existing Arenswap frontend to the deployed ArenSwap contract on Arc Testnet. The work touches three files in dependency order: `app/lib/contracts.ts` (static config, no dependencies), `app/hooks/useSwap.ts` (all contract logic, depends on contracts.ts), and `app/page.tsx` (UI wiring, depends on useSwap). A final `npm run build` checkpoint validates TypeScript correctness end-to-end.

## Tasks

- [x] 1. Create `app/lib/contracts.ts` — contract addresses and ABIs
  - Create `app/lib/contracts.ts` as a pure TypeScript module (no React, no hooks)
  - Export `ARENSWAP_ADDRESS` typed as `` `0x${string}` `` = `0x936B1516B784C3E2CC064e645BEBB614781D13Bd`
  - Export `USDC_ADDRESS` typed as `` `0x${string}` `` = `0x3600000000000000000000000000000000000000`
  - Export `EURC_ADDRESS` typed as `` `0x${string}` `` = `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`
  - Export `ARENSWAP_ABI` as a readonly array (`as const`) with fragments for `swapUSDCToEURC(uint256)`, `swapEURCToUSDC(uint256)`, and `swapRate()` view
  - Export `ERC20_ABI` as a readonly array (`as const`) with fragments for `approve(address,uint256)` and `balanceOf(address)`
  - No address literals or inline ABI arrays outside the six exported constants
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 2. Create `app/hooks/useSwap.ts` — swap state machine hook
  - [x] 2.1 Define exports: `SwapStatus` union type, `UseSwapReturn` interface, `encodeUsdcAmount` pure helper, `computeReceiveAmount` pure helper
    - `SwapStatus = 'idle' | 'approving' | 'approved' | 'swapping' | 'success' | 'error'`
    - `UseSwapReturn` interface with fields: `swapRate`, `isRateLoading`, `isRateError`, `status`, `error`, `successTxHash`, `executeSwap`, `resetError`
    - `encodeUsdcAmount(amount: string): bigint` — `parseFloat` → multiply by `1_000_000` → `Math.floor` → `BigInt`; return `0n` for non-positive/non-finite; throw `RangeError` if result exceeds `Number.MAX_SAFE_INTEGER`
    - `computeReceiveAmount(amount: string, swapRate: bigint): number` — returns `parseFloat(amount) * (Number(swapRate) / 1_000_000)`
    - _Requirements: 3.1, 5.2, 5.3, 5.4, 5.5, 2.3_

  - [ ]* 2.2 Write property test for `encodeUsdcAmount` — Property 1: amount encoding correctness
    - **Property 1: Amount encoding correctness**
    - **Validates: Requirements 3.1, 5.2**
    - Create `app/hooks/__tests__/useSwap.test.ts` using Vitest + fast-check
    - Tag: `// Feature: swap-integration, Property 1: amount encoding correctness`
    - `fc.float({ min: 0.000001, max: 9007.199254740991, noNaN: true })` → assert `encodeUsdcAmount(str) === BigInt(Math.floor(amount * 1_000_000))`
    - Run with `{ numRuns: 100 }`

  - [ ]* 2.3 Write property test for `computeReceiveAmount` — Property 4: receive amount computation
    - **Property 4: Receive amount computation**
    - **Validates: Requirements 2.3**
    - Tag: `// Feature: swap-integration, Property 4: receive amount computation`
    - `fc.float({ min: 0.000001, max: 1_000_000, noNaN: true })` × `fc.bigInt({ min: 1n, max: 2_000_000n })` → assert `Math.abs(computeReceiveAmount(str, rate) - expected) < 1e-9`
    - Run with `{ numRuns: 100 }`

  - [x] 2.4 Implement `useSwap` hook body — Wagmi hooks and state machine
    - Add `'use client'` directive at top of file
    - Call `useAccount()` for `address` and `isConnected`; call `useChainId()` for network check
    - Call `useReadContract` with `ARENSWAP_ABI` / `ARENSWAP_ADDRESS` / `swapRate` to get live rate, `isLoading`, `isError`
    - Declare two `useWriteContract` instances: `writeApprove` (for ERC-20 approve) and `writeSwap` (for swapUSDCToEURC)
    - Declare two `useWaitForTransactionReceipt` instances: one watching `writeApprove.data`, one watching `writeSwap.data`
    - Declare `status` state (`useState<SwapStatus>('idle')`) and `error` state (`useState<string | null>(null)`)
    - Declare `capturedAmount` as `useRef<bigint | null>(null)`
    - Implement `executeSwap(usdcAmount: string)`: encode amount into `capturedAmount.current`, set `status = 'approving'`, call `writeApprove.writeContract` with `ERC20_ABI` / `USDC_ADDRESS` / `approve` / `[ARENSWAP_ADDRESS, capturedAmount.current]`
    - Implement `resetError()`: set `status = 'idle'`, set `error = null`
    - _Requirements: 3.1, 3.2, 3.4, 3.9, 3.11, 4.5, 4.6_

  - [x] 2.5 Implement `useEffect` transitions and error handling
    - `useEffect` on `approveReceipt.status`: when `'success'` → set `status = 'approved'`; when `'reverted'` → set `status = 'error'`, set `error = 'Transaction reverted'`
    - `useEffect` on `status`: when `status === 'approved'` and `capturedAmount.current !== null` → call `writeSwap.writeContract` with `ARENSWAP_ABI` / `ARENSWAP_ADDRESS` / `swapUSDCToEURC` / `[capturedAmount.current]`, then set `status = 'swapping'`
    - `useEffect` on `swapReceipt.status`: when `'success'` → set `status = 'success'`; when `'reverted'` → set `status = 'error'`, set `error = 'Transaction reverted'`
    - `useEffect` on `writeApprove.error`: when non-null → set `status = 'error'`, set `error` to human-readable message
    - `useEffect` on `writeSwap.error`: when non-null → set `status = 'error'`, set `error` to human-readable message
    - Return `UseSwapReturn` object with all fields
    - _Requirements: 3.3, 3.6, 3.7, 3.8, 4.5, 4.6_

  - [ ]* 2.6 Write property test for captured amount consistency — Property 3
    - **Property 3: Captured amount consistency**
    - **Validates: Requirements 3.9**
    - Tag: `// Feature: swap-integration, Property 3: captured amount consistency`
    - Two `fc.float` arbitraries (initial amount, changed amount) → assert `encodeUsdcAmount(initial.toString()) === encodeUsdcAmount(initial.toString())` (captured ref is not re-read from input)
    - Run with `{ numRuns: 100 }`

- [x] 3. Checkpoint — Ensure `useSwap` compiles and pure helpers are correct
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Update `app/page.tsx` — wire `SwapCard` to `useSwap`
  - [x] 4.1 Add `Spinner` component and import `useSwap`
    - Add `Spinner` SVG component (animate-spin, `h-4 w-4`) as defined in the design document
    - Import `useSwap` from `../hooks/useSwap` at the top of the file
    - Import `useEffect`, `useRef` from React (add to existing React import)
    - _Requirements: 4.5, 4.6_

  - [x] 4.2 Replace placeholder rate with live `swapRate` in `SwapCard`
    - Call `useSwap()` at the top of `SwapCard` and destructure all return fields
    - Remove the `PLACEHOLDER_RATE` constant entirely
    - Compute `receiveAmount` using `computeReceiveAmount(payAmount, swapRate)` when `swapRate` is defined and `payAmount` is valid; otherwise empty string
    - Update `RateDisplay` to show `1 USDC ≈ ${(Number(swapRate) / 1e6).toFixed(4)} EURC` when rate is available, `"—"` while loading, `"Rate unavailable"` on error/zero
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 4.3 Wire button states — all 8 conditions
    - Import `useAccount` and `useChainId` from wagmi (or consume from `useSwap` return if exposed)
    - Map button label and disabled state to all 8 conditions from the design:
      1. Wallet not connected → "Connect Wallet" (disabled)
      2. Wrong network (chainId ≠ 5042002) → "Switch to Arc Testnet" (disabled)
      3. `status === 'approving'` → "Approving USDC…" + `<Spinner />` (disabled)
      4. `status === 'swapping'` → "Swapping…" + `<Spinner />` (disabled)
      5. `payAmount` empty or ≤ 0 → "Enter an amount" (disabled)
      6. `encodeUsdcAmount` throws → "Amount too large" (disabled)
      7. Otherwise → "Swap" (enabled), `onClick` calls `executeSwap(payAmount)`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.3, 5.5_

  - [ ]* 4.4 Write property test for button/input disabled during pending states — Property 2
    - **Property 2: No interaction while pending**
    - **Validates: Requirements 3.11, 4.10**
    - Tag: `// Feature: swap-integration, Property 2: no interaction while pending`
    - `fc.constantFrom('approving' as const, 'swapping' as const)` → render `SwapCard` with mocked `useSwap` returning that status → assert button `disabled` and Pay input `disabled`
    - Run with `{ numRuns: 100 }`

  - [x] 4.5 Add success toast with ArcScan link and auto-dismiss
    - When `status === 'success'`, render a toast element below the Swap button containing a link to `https://testnet.arcscan.app/tx/${successTxHash}` labelled "View on ArcScan"
    - Use `useEffect` + `setTimeout` (10 000 ms) to call `resetError()` / clear toast on auto-dismiss; clear the timeout on cleanup
    - _Requirements: 3.5, 4.7_

  - [x] 4.6 Add inline error display, input disabling, and `resetError` on change
    - Render inline error element below the Swap button when `error` is non-null
    - Disable the USDC Pay `TokenInput` when `status` is `'approving'` or `'swapping'`
    - Call `resetError()` inside the `onChange` handler of the USDC Pay input
    - _Requirements: 3.6, 3.7, 3.8, 4.8, 4.9, 4.10_

- [x] 5. Final checkpoint — `npm run build`
  - Run `npm run build` in `d:\arenswap-frontend`
  - Exit code must be 0 with no TypeScript errors or Next.js build errors
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- `encodeUsdcAmount` and `computeReceiveAmount` are exported pure functions — test them directly without rendering any component
- Property tests use fast-check with `numRuns: 100`; unit tests cover boundary values and each button-state condition
- The `capturedAmount` ref pattern ensures the same bigint is used for both the approve and swap calls regardless of input changes between the two transactions
- `approved` is a transient state never shown to the user; it exists solely to trigger the `useEffect` that fires the swap write

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["2.5", "2.6"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2", "4.3"] },
    { "id": 6, "tasks": ["4.4", "4.5", "4.6"] }
  ]
}
```
