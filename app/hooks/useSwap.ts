'use client'

import { useState, useRef, useEffect } from 'react'
import {
  useAccount,
  useChainId,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import {
  ARENSWAP_ABI,
  ARENSWAP_ADDRESS,
  ERC20_ABI,
  USDC_ADDRESS,
} from '../lib/contracts'

// ─── Types ─────────────────────────────────────────────────────────────────────

export type SwapStatus =
  | 'idle'
  | 'approving'
  | 'approved'
  | 'swapping'
  | 'success'
  | 'error'

export interface UseSwapReturn {
  swapRate:      bigint | undefined
  isRateLoading: boolean
  isRateError:   boolean
  status:        SwapStatus
  error:         string | null
  successTxHash: `0x${string}` | undefined
  executeSwap:   (usdcAmount: string) => void
  resetError:    () => void
}

// ─── Pure helpers (exported for testing) ──────────────────────────────────────

export function encodeUsdcAmount(amount: string): bigint {
  const parsed = parseFloat(amount)
  if (!isFinite(parsed) || parsed <= 0) return BigInt(0)
  const microUnits = Math.floor(parsed * 1_000_000)
  if (microUnits > Number.MAX_SAFE_INTEGER) throw new RangeError('Amount too large')
  return BigInt(microUnits)
}

export function computeReceiveAmount(amount: string, swapRate: bigint): number {
  return parseFloat(amount) * (Number(swapRate) / 1_000_000)
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

export default function useSwap(): UseSwapReturn {
  useAccount()
  useChainId()

  // Live swap rate from contract
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
  const capturedAmount = useRef<bigint | null>(null)

  // Two independent write instances
  const approveWrite = useWriteContract()
  const swapWrite    = useWriteContract()

  // Receipt watchers
  const approveReceipt = useWaitForTransactionReceipt({ hash: approveWrite.data })
  const swapReceipt    = useWaitForTransactionReceipt({ hash: swapWrite.data })

  // ─── executeSwap ─────────────────────────────────────────────────────────────
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

  function resetError(): void {
    setStatus('idle')
    setError(null)
  }

  // ─── Effects ─────────────────────────────────────────────────────────────────

  // Approval receipt → approved or error
  useEffect(() => {
    if (approveReceipt.status === 'success') {
      setStatus('approved')
    } else if (approveReceipt.status === 'error') {
      setStatus('error')
      setError('Approval transaction was reverted')
    }
  }, [approveReceipt.status])

  // Approved → fire swap
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

  // Swap receipt → success or error
  useEffect(() => {
    if (swapReceipt.status === 'success') {
      setStatus('success')
    } else if (swapReceipt.status === 'error') {
      setStatus('error')
      setError('Swap transaction was reverted')
    }
  }, [swapReceipt.status])

  // Approve write error
  useEffect(() => {
    if (approveWrite.error) {
      setStatus('error')
      setError(approveWrite.error.message ?? 'Approval failed')
    }
  }, [approveWrite.error])

  // Swap write error
  useEffect(() => {
    if (swapWrite.error) {
      setStatus('error')
      setError(swapWrite.error.message ?? 'Swap failed')
    }
  }, [swapWrite.error])

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
