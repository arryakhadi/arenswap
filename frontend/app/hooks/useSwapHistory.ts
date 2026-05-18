'use client'

/**
 * useSwapHistory — persists recent successful swaps in localStorage.
 *
 * Stores only non-sensitive data: timestamps, token symbols, amounts,
 * tx hashes, and chainId. Never stores private keys or API keys.
 * Keeps the latest 10 entries.
 */

import { useCallback, useEffect, useState, startTransition } from 'react'

const STORAGE_KEY = 'arenswap_history_v1'
const MAX_ENTRIES = 10

export type SwapHistoryStatus = 'success' | 'failed' | 'verification-failed'

export interface SwapHistoryEntry {
  id: string            // unique: timestamp + txHash prefix
  timestamp: number     // Unix ms
  chainId: number
  status: SwapHistoryStatus
  tokenIn: string
  tokenOut: string
  amountIn: string
  estimatedOut: string | null
  approveTxHash: string | null
  swapTxHash: string | null
  errorMessage?: string | null
}

function sanitizeStatus(status: unknown): SwapHistoryStatus {
  if (status === 'failed' || status === 'verification-failed') return status
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
      const sanitized: SwapHistoryEntry = {
        ...entry,
        status: sanitizeStatus((entry as Partial<SwapHistoryEntry>).status),
        estimatedOut: entry.estimatedOut ?? null,
        approveTxHash: entry.approveTxHash ?? null,
        swapTxHash: entry.swapTxHash ?? null,
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
      return sanitized.swapTxHash || sanitized.status === 'failed' ? sanitized : null
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

  const addEntry = useCallback((entry: Omit<SwapHistoryEntry, 'id'>) => {
    const hashPart = entry.swapTxHash ? entry.swapTxHash.slice(2, 10) : entry.status
    const id = `${entry.timestamp}-${hashPart}`
    const newEntry: SwapHistoryEntry = { ...entry, id }
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

  return { history, addEntry, clearHistory }
}
