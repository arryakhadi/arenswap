'use client'

import { useState, useRef, useEffect } from 'react'
import { useAccount, useChainId, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import {
  ARENSWAP_ABI,
  ARENSWAP_ADDRESS,
  ERC20_ABI,
  USDC_ADDRESS,
} from '../lib/contracts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SwapStatus =
  | 'idle'
  | 'approving'
  | 'approved'
  | 'swapping'
  | 'success'
  | 'error'

export interface UseSwapReturn {
  /** Raw on-chain swapRate bigint (e.g. 921500n). Undefined while loading. */
  swapRate: bigint | undefined
  /** True while swapRate() RPC call is in-flight */
  isRateLoading: boolean
  /** True if swapRate() call errored or returned 0n */
  isRateError: boolean
  /** Current state machine status */
  status: SwapStatus
  /** Human-readable error message, or null */
  error: string | null
  /** Swap transaction hash on success */
  successTxHash: `0x${string}` | undefined
  /** Initiate the approve → swap flow */
  executeSwap: (usdcAmount: string) => void
  /** Clear error and reset to idle (called when user edits input) */
  resetError: () => void
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Encodes a decimal USDC amount string into micro-units (bigint).
 * Returns 0n for non-positive or non-finite inputs.
 * Throws RangeError if the result exceeds Number.MAX_SAFE_INTEGER.
 */
export function encodeUsdcAmount(amount: string): bigint {
  const parsed = parseFloat(amount)
  if (!isFinite(parsed) || parsed <= 0) return BigInt(0)
  const microUnits = Math.floor(parsed * 1_000_000)
  if (microUnits > Number.MAX_SAFE_INTEGER) throw new RangeError('Amount too large')
  return BigInt(microUnits)
}

/**
 * Computes the EURC receive amount given a USDC amount string and the on-chain swap rate.
 */
export function computeReceiveAmount(amount: string, swapRate: bigint): number {
  return parseFloat(amount) * (Number(swapRate) / 1_000_000)
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export default function useSwap(): UseSwapReturn {
  // Wallet / network
  const { address, isConnected } = useAccount()
  const chainId = useChainId()

  // Suppress unused-variable warnings — these are available for consumers
  void address
  void isConnected
  void chainId

  // Live swap rate
  const {
    data: swapRateData,
    isLoading: isRateLoading,
    isError: isRateErrorRaw,
  } = useReadContract({
    abi: ARENSWAP_ABI,
    address: ARENSWAP_ADDRESS,
    functionName: 'swapRate',
  })

  const swapRate = swapRateData as bigint | undefined
  const isRateError = isRateErrorRaw || swapRate === BigInt(0)

  // State machine
  const [status, setStatus] = useState<SwapStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  // Captured amount ref — set at button-click time, used for both approve and swap
  const capturedAmount = useRef<bigint | null>(null)

  // Two independent write instances
  const approveWrite = useWriteContract()
  const swapWrite = useWriteContract()

  // Wait for approve tx
  const approveReceipt = useWaitForTransactionReceipt({
    hash: approveWrite.data,
  })

  // Wait for swap tx
  const swapReceipt = useWaitForTransactionReceipt({
    hash: swapWrite.data,
  })

  // ---------------------------------------------------------------------------
  // executeSwap — entry point
  // ---------------------------------------------------------------------------
  function executeSwap(usdcAmount: string): void {
    const encoded = encodeUsdcAmount(usdcAmount)
    if (encoded === BigInt(0)) return

    capturedAmount.current = encoded
    setStatus('approving')
    setError(null)

    approveWrite.writeContract({
      abi: ERC20_ABI,
      address: USDC_ADDRESS,
      functionName: 'approve',
      args: [ARENSWAP_ADDRESS, encoded],
    })
  }

  // ---------------------------------------------------------------------------
  // resetError
  // ---------------------------------------------------------------------------
  function resetError(): void {
    setStatus('idle')
    setError(null)
  }

  // ---------------------------------------------------------------------------
  // Effect: approval receipt → transition to 'approved' or 'error'
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (approveReceipt.status === 'success') {
      setStatus('approved')
    } else if (approveReceipt.status === 'error') {
      // useWaitForTransactionReceipt uses 'error' for reverted txs in wagmi v2
      setStatus('error')
      setError('Approval transaction was reverted')
    }
  }, [approveReceipt.status])

  // ---------------------------------------------------------------------------
  // Effect: 'approved' → fire swap write
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (status === 'approved' && capturedAmount.current !== null) {
      swapWrite.writeContract({
        abi: ARENSWAP_ABI,
        address: ARENSWAP_ADDRESS,
        functionName: 'swapUSDCToEURC',
        args: [capturedAmount.current],
      })
      setStatus('swapping')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // ---------------------------------------------------------------------------
  // Effect: swap receipt → transition to 'success' or 'error'
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (swapReceipt.status === 'success') {
      setStatus('success')
    } else if (swapReceipt.status === 'error') {
      setStatus('error')
      setError('Swap transaction was reverted')
    }
  }, [swapReceipt.status])

  // ---------------------------------------------------------------------------
  // Effect: approve write error
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (approveWrite.error) {
      setStatus('error')
      setError(approveWrite.error.message ?? 'Approval failed')
    }
  }, [approveWrite.error])

  // ---------------------------------------------------------------------------
  // Effect: swap write error
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (swapWrite.error) {
      setStatus('error')
      setError(swapWrite.error.message ?? 'Swap failed')
    }
  }, [swapWrite.error])

  // ---------------------------------------------------------------------------
  // Derive successTxHash
  // ---------------------------------------------------------------------------
  const successTxHash: `0x${string}` | undefined =
    status === 'success' ? swapWrite.data : undefined

  return {
    swapRate,
    isRateLoading,
    isRateError,
    status,
    error,
    successTxHash,
    executeSwap,
    resetError,
  }
}
