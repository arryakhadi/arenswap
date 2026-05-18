'use client'

/**
 * useSwapHistory — persists recent Arenswap transactions in localStorage.
 *
 * Stores only non-sensitive data: timestamps, token symbols, amounts,
 * tx hashes, and chainId. Never stores private keys or API keys.
 * Keeps the latest 30 entries.
 */

import { useCallback, useEffect, useState, startTransition } from 'react'

const STORAGE_KEY = 'arenswap_history_v1'
const MAX_ENTRIES = 30

export type TransactionType = 'swap' | 'send' | 'batch_send' | 'approval' | 'revoke'
export type TransactionStatus = 'success' | 'failed' | 'verification_failed' | 'rejected' | 'pending'
export type SwapHistoryStatus = 'success' | 'failed' | 'verification-failed'

export interface SwapHistoryEntry {
  id: string            // unique: timestamp + txHash prefix
  timestamp: number     // Unix ms
  chainId: number
  type?: TransactionType
  status: SwapHistoryStatus | TransactionStatus
  walletAddress?: string | null
  tokenIn?: string
  tokenOut?: string
  token?: string
  amountIn?: string
  amountOut?: string | null
  amount?: string
  estimatedOut?: string | null
  recipient?: string | null
  approveTxHash?: string | null
  swapTxHash?: string | null
  txHash?: string | null
  approvalTxHash?: string | null
  spender?: string | null
  verificationSummary?: string | null
  errorMessage?: string | null
}

function sanitizeStatus(status: unknown): SwapHistoryEntry['status'] {
  if (status === 'failed' || status === 'rejected' || status === 'pending') return status
  if (status === 'verification-failed' || status === 'verification_failed') return 'verification_failed'
  return 'success'
}

function loadHistory(): SwapHistoryEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Sanitize entries: drop any with obviously raw/corrupted estimatedOut values.
    // A raw base-unit string like "1082974" for a 6-decimal token would be > 1000
    // when parsed as a float, which is implausible for a formatted decimal output.
    // We keep the entry but null out the bad estimatedOut rather than dropping it.
    return (parsed as SwapHistoryEntry[]).map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const txHash = entry.txHash ?? entry.swapTxHash ?? null
      const sanitized: SwapHistoryEntry = {
        ...entry,
        type: entry.type ?? 'swap',
        status: sanitizeStatus((entry as Partial<SwapHistoryEntry>).status),
        walletAddress: entry.walletAddress ?? null,
        amountIn: entry.amountIn ?? entry.amount ?? '',
        amountOut: entry.amountOut ?? entry.estimatedOut ?? null,
        estimatedOut: entry.estimatedOut ?? null,
        approveTxHash: entry.approveTxHash ?? null,
        swapTxHash: entry.swapTxHash ?? null,
        txHash,
        approvalTxHash: entry.approvalTxHash ?? entry.approveTxHash ?? null,
        recipient: entry.recipient ?? null,
        spender: entry.spender ?? null,
        verificationSummary: entry.verificationSummary ?? null,
        errorMessage: entry.errorMessage ?? null,
      }
      if (sanitized.estimatedOut !== null && sanitized.estimatedOut !== undefined) {
        const n = parseFloat(String(sanitized.estimatedOut))
        // If the value looks like a raw integer (no decimal point, very large number),
        // it was stored before the formatting fix — clear it to avoid misleading display.
        if (
          isFinite(n) &&
          n > 10000 &&
          !String(sanitized.estimatedOut).includes('.')
        ) {
          sanitized.estimatedOut = null
        }
      }
      return sanitized.txHash || sanitized.status === 'failed' || sanitized.status === 'rejected' ? sanitized : null
    }).filter(Boolean) as SwapHistoryEntry[]
  } catch {
    return []
  }
}

function saveHistory(entries: SwapHistoryEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // localStorage may be unavailable (private browsing, quota exceeded)
  }
}

export function useSwapHistory() {
  const [history, setHistory] = useState<SwapHistoryEntry[]>([])

  // Load on mount (client-only)
  useEffect(() => {
    const loaded = loadHistory()
    startTransition(() => setHistory(loaded))
  }, [])

  const addEntry = useCallback((entry: Omit<SwapHistoryEntry, 'id' | 'type' | 'txHash'>) => {
    const txHash = entry.swapTxHash ?? null
    const hashPart = txHash ? txHash.slice(2, 10) : String(entry.status)
    const id = `${entry.timestamp}-${hashPart}`
    const newEntry: SwapHistoryEntry = { ...entry, type: 'swap', txHash, id }
    setHistory((prev) => {
      const updated = [newEntry, ...prev].slice(0, MAX_ENTRIES)
      saveHistory(updated)
      return updated
    })
  }, [])

  const addTransaction = useCallback((entry: Omit<SwapHistoryEntry, 'id'>) => {
    const txHash = entry.txHash ?? entry.swapTxHash ?? entry.approvalTxHash ?? entry.approveTxHash ?? null
    const hashPart = txHash ? txHash.slice(2, 10) : String(entry.status)
    const id = `${entry.timestamp}-${entry.type ?? 'tx'}-${hashPart}`
    const newEntry: SwapHistoryEntry = { ...entry, type: entry.type ?? 'send', txHash, id }
    setHistory((prev) => {
      const updated = [newEntry, ...prev].slice(0, MAX_ENTRIES)
      saveHistory(updated)
      return updated
    })
  }, [])

  const clearHistory = useCallback(() => {
    setHistory([])
    saveHistory([])
  }, [])

  const clearFailed = useCallback(() => {
    setHistory((prev) => {
      const updated = prev.filter((entry) => entry.status === 'success' || entry.status === 'pending')
      saveHistory(updated)
      return updated
    })
  }, [])

  return { history, addEntry, addTransaction, clearHistory, clearFailed }
}
