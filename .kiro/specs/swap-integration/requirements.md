# Requirements Document

## Introduction

This feature wires the existing Arenswap frontend UI to the deployed ArenSwap smart contract on Arc Testnet (Chain ID 5042002). The frontend currently renders a SwapCard with a hardcoded exchange rate and a non-functional Swap button. This spec covers four areas: (1) a contract configuration module as the single source of truth for addresses and ABIs, (2) live swap rate display read directly from the contract, (3) a two-step approve-then-swap execution flow, and (4) UX state management with user feedback throughout the transaction lifecycle.

The stack is Next.js 16 App Router, Wagmi v2, Viem, RainbowKit 2.x, and @tanstack/react-query 5.x. All interactive components are Client Components (`'use client'`). No server-side rendering of wallet state is required or expected.

## Glossary

- **ArenSwap_Contract**: The deployed smart contract at `0x936B1516B784C3E2CC064e645BEBB614781D13Bd` on Arc Testnet that executes USDC↔EURC swaps.
- **USDC_Token**: The ERC-20 USD Coin token at `0x3600000000000000000000000000000000000000` on Arc Testnet, using 6 decimal places.
- **EURC_Token**: The ERC-20 Euro Coin token at `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` on Arc Testnet, using 6 decimal places.
- **SwapRate**: The value returned by `ArenSwap_Contract.swapRate()`, a `uint256` scaled by 1e6 representing EURC micro-units per USDC micro-unit (e.g., `921500` = 0.9215 EURC per USDC).
- **ContractConfig**: The module at `app/lib/contracts.ts` that exports all contract addresses and ABIs.
- **SwapCard**: The React Client Component in `app/page.tsx` that renders the swap UI.
- **ApprovalStep**: The first transaction in the swap flow — calling `approve(arenSwapAddress, usdcAmount)` on USDC_Token.
- **SwapStep**: The second transaction in the swap flow — calling `swapUSDCToEURC(usdcAmount)` on ArenSwap_Contract, executed only after ApprovalStep confirms.
- **ArcScan**: The block explorer at `https://testnet.arcscan.app` used to link to confirmed transactions.
- **Arc_Testnet**: The blockchain network with Chain ID 5042002 configured in `app/lib/wagmi.ts`.
- **Wagmi**: The React hooks library (v2) used for all contract reads and writes.
- **RainbowKit**: The wallet connection UI library (v2) that provides the ConnectButton and wallet modal.

---

## Requirements

### Requirement 1: Contract Configuration Module

**User Story:** As a developer, I want a single source of truth for all contract addresses and ABIs, so that any future address or ABI change requires editing only one file.

#### Acceptance Criteria

1. THE ContractConfig SHALL export a constant `ARENSWAP_ADDRESS` typed as `` `0x${string}` `` with the value `0x936B1516B784C3E2CC064e645BEBB614781D13Bd`.
2. THE ContractConfig SHALL export a constant `USDC_ADDRESS` typed as `` `0x${string}` `` with the value `0x3600000000000000000000000000000000000000`.
3. THE ContractConfig SHALL export a constant `EURC_ADDRESS` typed as `` `0x${string}` `` with the value `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`.
4. THE ContractConfig SHALL export a constant `ARENSWAP_ABI` as a readonly array containing ABI fragment objects (each with `name`, `type`, `inputs`, and `outputs` fields) for at minimum: `swapUSDCToEURC(uint256 usdcAmount)`, `swapEURCToUSDC(uint256 eurcAmount)`, and the `swapRate()` view function returning `uint256`.
5. THE ContractConfig SHALL export a constant `ERC20_ABI` as a readonly array containing ABI fragment objects for at minimum: `approve(address spender, uint256 amount) returns (bool)` and `balanceOf(address account) returns (uint256)`.
6. THE ContractConfig module SHALL NOT contain any address literal matching the pattern `/^0x[0-9a-fA-F]{40}$/` outside of the three exported address constants, and SHALL NOT define any inline ABI arrays outside of the two exported ABI constants.

---

### Requirement 2: Live Swap Rate Display

**User Story:** As a user, I want to see the current exchange rate fetched directly from the contract, so that the rate shown in the UI always reflects the on-chain state.

#### Acceptance Criteria

1. WHEN the SwapCard renders, THE SwapCard SHALL call `swapRate()` on ArenSwap_Contract using Wagmi's `useReadContract` hook with the address and ABI from ContractConfig.
2. WHEN `swapRate()` returns a non-zero value, THE SwapCard SHALL compute the display rate as `Number(swapRate) / 1e6` and render it in the RateDisplay component in place of any hardcoded placeholder.
3. WHEN `swapRate()` returns a non-zero value, THE SwapCard SHALL compute the EURC receive amount as `usdcAmount * (Number(swapRate) / 1e6)` and display it in the Receive input field.
4. WHILE the `swapRate()` call is loading, THE SwapCard SHALL display `"—"` as a non-numeric placeholder in the RateDisplay component and SHALL display an empty string in the Receive input field.
5. IF the `swapRate()` call returns an error, THEN THE SwapCard SHALL display `"Rate unavailable"` in the RateDisplay component and SHALL display an empty string in the Receive input field.
6. IF `swapRate()` returns `0`, THEN THE SwapCard SHALL treat it identically to an error state: display `"Rate unavailable"` in RateDisplay and an empty string in the Receive field.
7. THE SwapCard SHALL NOT contain the identifier `PLACEHOLDER_RATE`; the hardcoded constant SHALL be removed and replaced by the live rate from the contract.

---

### Requirement 3: Two-Step Swap Execution Flow

**User Story:** As a user, I want to swap USDC for EURC by clicking the Swap button, so that my tokens are exchanged on-chain at the current rate.

#### Acceptance Criteria

1. WHEN the user clicks the Swap button and no transaction is pending, THE SwapCard SHALL initiate the ApprovalStep by calling `approve(ARENSWAP_ADDRESS, usdcAmountInMicroUnits)` on USDC_Token, where `usdcAmountInMicroUnits` is the user-entered amount multiplied by `1_000_000`, floored, and cast to `bigint`.
2. WHEN the ApprovalStep transaction hash is available, THE SwapCard SHALL track its confirmation status using `useWaitForTransactionReceipt`.
3. WHEN `useWaitForTransactionReceipt` reports the ApprovalStep as confirmed with status `"success"`, THE SwapCard SHALL immediately initiate the SwapStep by calling `swapUSDCToEURC(usdcAmountInMicroUnits)` on ArenSwap_Contract using the same `usdcAmountInMicroUnits` captured at button-click time.
4. WHEN the SwapStep transaction hash is available, THE SwapCard SHALL track its confirmation status using `useWaitForTransactionReceipt`.
5. WHEN `useWaitForTransactionReceipt` reports the SwapStep as confirmed with status `"success"`, THE SwapCard SHALL display a success notification containing a hyperlink to `https://testnet.arcscan.app/tx/{swapTxHash}`. The notification SHALL persist until the user dismisses it or 10 seconds elapse, whichever comes first.
6. IF the ApprovalStep write call returns an error, THEN THE SwapCard SHALL display a human-readable error message inline below the Swap button and SHALL NOT proceed to the SwapStep. The error SHALL persist until the user modifies the input amount or clicks Swap again.
7. IF the SwapStep write call returns an error, THEN THE SwapCard SHALL display a human-readable error message inline below the Swap button. The error SHALL persist until the user modifies the input amount or clicks Swap again.
8. IF `useWaitForTransactionReceipt` reports any transaction as reverted (status `"reverted"`), THEN THE SwapCard SHALL display an inline error message stating the transaction was reverted. The error SHALL persist until the user modifies the input amount or clicks Swap again.
9. THE SwapCard SHALL capture `usdcAmountInMicroUnits` at the moment the Swap button is clicked and SHALL use that captured value for both the ApprovalStep and the SwapStep without re-reading the input field.
10. IF the user-entered USDC amount is zero, empty, or not a positive number, THEN THE SwapCard SHALL NOT initiate any transaction when the Swap button is clicked.
11. WHILE any transaction is pending (ApprovalStep or SwapStep), THE SwapCard SHALL disable the Swap button to prevent duplicate submissions.

---

### Requirement 4: UX States and Button Feedback

**User Story:** As a user, I want the Swap button and surrounding UI to clearly reflect the current state of my wallet connection and transaction progress, so that I always know what action is required or what is happening.

#### Acceptance Criteria

1. WHEN the user's wallet is not connected, THE SwapCard SHALL display a disabled "Connect Wallet" button that, when clicked, opens the RainbowKit wallet connection modal.
2. WHEN the user's wallet is connected to a network other than Arc_Testnet (Chain ID 5042002), THE SwapCard SHALL display a disabled button with the label "Switch to Arc Testnet".
3. WHEN the user's wallet is connected to Arc_Testnet and the USDC Pay input is empty or zero, THE SwapCard SHALL display a disabled button with the label "Enter an amount".
4. WHEN the user's wallet is connected to Arc_Testnet and the USDC Pay input contains a valid positive amount, THE SwapCard SHALL display an enabled button with the label "Swap".
5. WHILE the ApprovalStep transaction is pending, THE SwapCard SHALL display a disabled button with the label "Approving USDC..." and a visible loading spinner adjacent to the label.
6. WHILE the SwapStep transaction is pending, THE SwapCard SHALL display a disabled button with the label "Swapping..." and a visible loading spinner adjacent to the label.
7. WHEN a swap completes successfully, THE SwapCard SHALL display a success notification below the Swap button containing a hyperlink labelled "View on ArcScan" pointing to `https://testnet.arcscan.app/tx/{swapTxHash}`.
8. WHEN an error occurs during ApprovalStep or SwapStep, THE SwapCard SHALL display a human-readable description of the failure reason in an inline error element positioned below the Swap button.
9. IF the user modifies the USDC Pay input amount after an error is displayed, THEN THE SwapCard SHALL clear the inline error message.
10. WHILE any transaction is pending, THE SwapCard SHALL disable the USDC Pay input field to prevent the user from changing the amount mid-flow.

---

### Requirement 5: Input Validation and Amount Encoding

**User Story:** As a developer, I want all user-entered amounts to be correctly validated and encoded before being sent to the contract, so that no malformed or out-of-range values reach the on-chain functions.

#### Acceptance Criteria

1. WHEN the user types in the USDC Pay input, THE SwapCard SHALL accept only characters that are digits (`0–9`) or a single decimal point, silently discarding any other character at the point of entry.
2. WHEN computing `usdcAmountInMicroUnits`, THE SwapCard SHALL multiply the parsed decimal amount by `1_000_000`, apply `Math.floor`, and cast the result to `bigint` before passing it to any contract write call.
3. IF the computed `usdcAmountInMicroUnits` is `0n` or less after encoding, THEN THE SwapCard SHALL treat the input as invalid and SHALL display the "Enter an amount" disabled button state.
4. THE SwapCard SHALL pass `usdcAmountInMicroUnits` as a `bigint` to all `writeContract` calls; JavaScript `number` type SHALL NOT be used for any on-chain token amount argument.
5. IF the user-entered amount, after multiplication by `1_000_000`, exceeds `9_007_199_254_740_991` (JavaScript `Number.MAX_SAFE_INTEGER`), THEN THE SwapCard SHALL display an inline validation error "Amount too large" below the Pay input and SHALL disable the Swap button.
