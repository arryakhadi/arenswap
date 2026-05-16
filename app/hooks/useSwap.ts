'use client'

import { useState, useRef, useEffect, startTransition } from 'react'
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
  | 'needs-approval'
  | 'approving'
  | 'approved'
  | 'swapping'
  | 'success'
  | 'error'

export interface UseSwapReturn {
  swapRate:      bigint | undefined
  isRateLoading: boolean
  isRateError:   boolean
  needsApproval: boolean
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

export default function useSwap(usdcAmount: string = ''): UseSwapReturn {
  const { address } = useAccount()
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

  // Live USDC allowance for the connected wallet
  const {
    data: allowanceData,
    isLoading: isAllowanceLoading,
  } = useReadContract({
    abi: ERC20_ABI,
    address: USDC_ADDRESS,
    functionName: 'allowance',
    args: address ? [address, ARENSWAP_ADDRESS] : undefined,
    query: { enabled: !!address },
  })

  const allowance = allowanceData as bigint | undefined

  // Derive needsApproval — computed, not stored in state
  const needsApproval: boolean = (() => {
    if (!usdcAmount || usdcAmount === '' || Number(usdcAmount) <= 0) return false
    let encoded: bigint
    try { encoded = encodeUsdcAmount(usdcAmount) } catch { return false }
    if (encoded === BigInt(0)) return false
    // Conservative: treat loading/undefined allowance as needing approval
    if (isAllowanceLoading || allowance === undefined) return true
    return allowance < encoded
  })()

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
  function executeSwap(amount: string): void {
    const encoded = encodeUsdcAmount(amount)
    if (encoded === BigInt(0)) return

    // Guard: allowance still loading — do nothing
    if (isAllowanceLoading || allowance === undefined) return

    capturedAmount.current = encoded
    setError(null)

    if (allowance >= encoded) {
      // Sufficient allowance — skip approve, go straight to swap
      setStatus('swapping')
      swapWrite.writeContract({
        abi: ARENSWAP_ABI,
        address: ARENSWAP_ADDRESS,
        functionName: 'swapUSDCToEURC',
        args: [encoded],
      })
    } else {
      // Insufficient allowance — request approval first
      setStatus('needs-approval')
      setStatus('approving')
      approveWrite.writeContract({
        abi: ERC20_ABI,
        address: USDC_ADDRESS,
        functionName: 'approve',
        args: [ARENSWAP_ADDRESS, encoded],
      })
    }
  }

  function resetError(): void {
    setStatus('idle')
    setError(null)
  }

  // ─── Effects ─────────────────────────────────────────────────────────────────

  // Approval receipt → approved or error
  useEffect(() => {
    if (approveReceipt.status === 'success') {
      startTransition(() => setStatus('approved'))
    } else if (approveReceipt.status === 'error') {
      startTransition(() => {
        setStatus('error')
        setError('Approval transaction was reverted')
      })
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
      startTransition(() => setStatus('success'))
    } else if (swapReceipt.status === 'error') {
      startTransition(() => {
        setStatus('error')
        setError('Swap transaction was reverted')
      })
    }
  }, [swapReceipt.status])

  // Approve write error
  useEffect(() => {
    if (approveWrite.error) {
      startTransition(() => {
        setStatus('error')
        setError(approveWrite.error!.message ?? 'Approval failed')
      })
    }
  }, [approveWrite.error])

  // Swap write error
  useEffect(() => {
    if (swapWrite.error) {
      startTransition(() => {
        setStatus('error')
        setError(swapWrite.error!.message ?? 'Swap failed')
      })
    }
  }, [swapWrite.error])

  const successTxHash: `0x${string}` | undefined =
    status === 'success' ? swapWrite.data : undefined

  return {
    swapRate,
    isRateLoading,
    isRateError,
    needsApproval,
    status,
    error,
    successTxHash,
    executeSwap,
    resetError,
  }
}
