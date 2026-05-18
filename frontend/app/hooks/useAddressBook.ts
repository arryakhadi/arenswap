'use client'

import { useCallback, useEffect, useState } from 'react'
import { isAddress } from 'viem'

const STORAGE_KEY = 'arenswap_address_book_v1'
const MAX_ENTRIES = 25

export interface AddressBookEntry {
  id: string
  label: string
  address: `0x${string}`
  createdAt: number
}

function loadAddressBook(): AddressBookEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        id: String(entry.id ?? `${entry.address}-${entry.createdAt ?? Date.now()}`),
        label: String(entry.label ?? '').slice(0, 48),
        address: String(entry.address ?? '') as `0x${string}`,
        createdAt: Number(entry.createdAt ?? Date.now()),
      }))
      .filter((entry) => isAddress(entry.address))
      .slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

function saveAddressBook(entries: AddressBookEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    // localStorage may be unavailable.
  }
}

export function useAddressBook() {
  const [entries, setEntries] = useState<AddressBookEntry[]>([])

  useEffect(() => {
    queueMicrotask(() => setEntries(loadAddressBook()))
  }, [])

  const addOrUpdate = useCallback((label: string, address: string) => {
    if (!isAddress(address)) return false
    const normalized = address as `0x${string}`
    setEntries((prev) => {
      const existing = prev.find((entry) => entry.address.toLowerCase() === normalized.toLowerCase())
      const next = existing
        ? prev.map((entry) => entry.id === existing.id ? { ...entry, label: label.trim() || entry.label } : entry)
        : [
            {
              id: `${Date.now()}-${normalized.slice(2, 8)}`,
              label: label.trim() || `${normalized.slice(0, 6)}...${normalized.slice(-4)}`,
              address: normalized,
              createdAt: Date.now(),
            },
            ...prev,
          ]
      saveAddressBook(next)
      return next.slice(0, MAX_ENTRIES)
    })
    return true
  }, [])

  const remove = useCallback((id: string) => {
    setEntries((prev) => {
      const next = prev.filter((entry) => entry.id !== id)
      saveAddressBook(next)
      return next
    })
  }, [])

  return { entries, addOrUpdate, remove }
}
