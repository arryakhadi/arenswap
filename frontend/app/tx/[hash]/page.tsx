'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { usePublicClient } from 'wagmi'
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_NAME,
  ERC20_ABI,
  SUPPORTED_TOKENS,
  explorerTxUrl,
  formatTokenAmount,
  tokenAddress,
  truncateHash,
  type SupportedToken,
} from '@/app/lib/tokens'
import { decodeEventLog } from 'viem'
import type { SwapHistoryEntry } from '@/app/hooks/useSwapHistory'

interface DecodedTransfer {
  token: SupportedToken
  from: string
  to: string
  value: string
}

function loadLocalTransaction(hash: string): SwapHistoryEntry | null {
  if (typeof window === 'undefined') return null
  try {
    const parsed = JSON.parse(window.localStorage.getItem('arenswap_history_v1') ?? '[]')
    if (!Array.isArray(parsed)) return null
    return parsed.find((entry) => {
      const txHash = entry?.txHash ?? entry?.swapTxHash ?? entry?.approvalTxHash ?? entry?.approveTxHash
      return typeof txHash === 'string' && txHash.toLowerCase() === hash.toLowerCase()
    }) ?? null
  } catch {
    return null
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(value).then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }).catch(() => {})}
      className="rounded-lg border border-white/[0.08] px-3 py-2 text-xs font-semibold text-white/35 hover:text-white/70"
    >
      {copied ? 'Copied' : 'Copy tx hash'}
    </button>
  )
}

export default function TransactionReceiptPage() {
  const params = useParams<{ hash: string }>()
  const hash = params.hash
  const publicClient = usePublicClient()
  const [localTx, setLocalTx] = useState<SwapHistoryEntry | null>(null)
  const [receipt, setReceipt] = useState<{ status: string; blockNumber: bigint } | null>(null)
  const [transfers, setTransfers] = useState<DecodedTransfer[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    queueMicrotask(() => setLocalTx(loadLocalTransaction(hash)))
  }, [hash])

  useEffect(() => {
    let cancelled = false
    async function fetchReceipt() {
      if (!publicClient || !hash) return
      try {
        const result = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` })
        if (cancelled) return
        setReceipt({ status: result.status, blockNumber: result.blockNumber })
        const decoded: DecodedTransfer[] = []
        for (const log of result.logs) {
          const token = SUPPORTED_TOKENS.find((item) => log.address.toLowerCase() === tokenAddress(item).toLowerCase())
          if (!token) continue
          try {
            const event = decodeEventLog({
              abi: ERC20_ABI,
              eventName: 'Transfer',
              topics: log.topics,
              data: log.data,
            })
            const args = event.args as { from: string; to: string; value: bigint }
            decoded.push({
              token,
              from: args.from,
              to: args.to,
              value: `${formatTokenAmount(args.value, token)} ${token}`,
            })
          } catch {
            // Ignore non-Transfer logs.
          }
        }
        setTransfers(decoded)
      } catch {
        if (!cancelled) setError('On-chain receipt is not available from the current RPC yet.')
      }
    }
    fetchReceipt().catch(() => {})
    return () => { cancelled = true }
  }, [hash, publicClient])

  const knownType = localTx?.type ?? 'unknown'
  const title = useMemo(() => `${knownType === 'unknown' ? 'Transaction' : knownType.replace('_', ' ')} receipt`, [knownType])

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0b0f] px-4 py-10 text-white">
      <div className="w-full max-w-xl rounded-3xl border border-white/[0.08] bg-[#111318] p-6 shadow-2xl shadow-black/60">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="mb-1 text-xs uppercase tracking-wider text-white/35">{ARC_TESTNET_NAME}</p>
            <h1 className="text-xl font-semibold capitalize">{title}</h1>
          </div>
          <Link href="/" className="rounded-lg border border-white/[0.08] px-3 py-2 text-xs font-semibold text-white/40 hover:text-white/75">Back</Link>
        </div>

        <div className="space-y-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-sm">
          <div className="flex items-start justify-between gap-4">
            <span className="text-white/35">Tx hash</span>
            <span className="max-w-[280px] break-all text-right font-mono text-xs text-white/70">{hash}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-white/35">Chain</span>
            <span className="text-white/70">{ARC_TESTNET_NAME} ({ARC_TESTNET_CHAIN_ID})</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-white/35">Status</span>
            <span className="text-white/70">{receipt?.status ?? localTx?.status ?? 'Unknown'}</span>
          </div>
          {receipt && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-white/35">Block</span>
              <span className="text-white/70">{receipt.blockNumber.toString()}</span>
            </div>
          )}
          {localTx?.token && <div className="flex items-center justify-between gap-4"><span className="text-white/35">Token</span><span className="text-white/70">{localTx.token}</span></div>}
          {(localTx?.amount ?? localTx?.amountIn) && <div className="flex items-center justify-between gap-4"><span className="text-white/35">Amount</span><span className="text-white/70">{localTx.amount ?? localTx.amountIn}</span></div>}
          {localTx?.estimatedOut && <div className="flex items-center justify-between gap-4"><span className="text-white/35">Received</span><span className="text-white/70">{localTx.estimatedOut} {localTx.tokenOut ?? ''}</span></div>}
          {localTx?.recipient && <div className="flex items-start justify-between gap-4"><span className="text-white/35">Recipient</span><span className="max-w-[280px] break-all text-right font-mono text-xs text-white/70">{localTx.recipient}</span></div>}
          {localTx?.approveTxHash && <div className="flex items-start justify-between gap-4"><span className="text-white/35">Approval tx</span><a href={explorerTxUrl(localTx.approveTxHash)} target="_blank" rel="noopener noreferrer" className="max-w-[280px] break-all text-right font-mono text-xs text-blue-300/70 underline underline-offset-2">{localTx.approveTxHash}</a></div>}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <CopyButton value={hash} />
          <a href={explorerTxUrl(hash)} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-white/[0.08] px-3 py-2 text-xs font-semibold text-blue-300/70 hover:text-blue-200">Open Arcscan {truncateHash(hash)}</a>
        </div>

        {error && <p className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-300/80">{error}</p>}

        {transfers.length > 0 && (
          <div className="mt-6">
            <h2 className="mb-3 text-sm font-semibold text-white/65">Transfer Events</h2>
            <div className="space-y-2">
              {transfers.map((transfer, index) => (
                <div key={`${transfer.from}-${transfer.to}-${index}`} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 text-xs">
                  <div className="mb-1 font-semibold text-white/70">{transfer.value}</div>
                  <div className="truncate text-white/35">From {transfer.from}</div>
                  <div className="truncate text-white/35">To {transfer.to}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
