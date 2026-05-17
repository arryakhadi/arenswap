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

export interface SwapHistoryEntry {
  id: string            // unique: timestamp + txHash prefix
  timestamp: number     // Unix ms
  chainId: number
  tokenIn: string
  tokenOut: string
  amountIn: string
  estimatedOut: string | null
  approveTxHash: string | null
  swapTxHash: string
}

function loadHistory(): SwapHistoryEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as SwapHistoryEntry[]
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
    const id = `${entry.timestamp}-${entry.swapTxHash.slice(2, 10)}`
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
