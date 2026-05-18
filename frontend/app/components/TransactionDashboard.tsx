'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { encodeFunctionData, isAddress, zeroAddress } from 'viem'
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi'
import CircleSwapBox from '@/app/components/CircleSwapBox'
import { useAddressBook } from '@/app/hooks/useAddressBook'
import { useSwapHistory, type SwapHistoryEntry, type TransactionType } from '@/app/hooks/useSwapHistory'
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_NAME,
  CIRCLE_SWAP_ADAPTER,
  ERC20_ABI,
  SUPPORTED_TOKENS,
  TOKENS,
  decodeExpectedTransfer,
  explorerAddressUrl,
  explorerTxUrl,
  formatTokenAmount,
  parseTokenAmount,
  tokenAddress,
  truncateHash,
  type SupportedToken,
} from '@/app/lib/tokens'

type Mode = 'swap' | 'send' | 'batch' | 'portfolio' | 'approvals' | 'history'
type TxStatus = 'idle' | 'review' | 'pending' | 'success' | 'verification_failed' | 'rejected' | 'error'

const MODE_LABELS: Array<{ value: Mode; label: string }> = [
  { value: 'swap', label: 'Swap' },
  { value: 'send', label: 'Send' },
  { value: 'batch', label: 'Batch' },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'history', label: 'History' },
]

const LOW_USDC_RAW = BigInt(2_000_000)

function nowMs(): number {
  return new Date().getTime()
}

function isUserRejection(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('user rejected') || lower.includes('user denied') || lower.includes('rejected the request') || lower.includes('action_rejected')
}

function PrimaryButton({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-2xl py-3.5 text-sm font-semibold transition-all ${disabled ? 'cursor-not-allowed bg-white/[0.06] text-white/25' : 'bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-500/20 hover:from-blue-400 hover:to-indigo-500'}`}
    >
      {children}
    </button>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-xs font-medium uppercase tracking-wider text-white/40">{children}</label>
}

function TokenSelect({ value, onChange, disabled }: { value: SupportedToken; onChange: (token: SupportedToken) => void; disabled?: boolean }) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as SupportedToken)}
      disabled={disabled}
      className="w-full rounded-xl border border-white/[0.08] bg-white/[0.06] px-3 py-2.5 text-sm font-semibold text-white outline-none hover:border-white/[0.14] focus:border-blue-500/50 disabled:opacity-50"
    >
      {SUPPORTED_TOKENS.map((token) => (
        <option key={token} value={token} className="bg-[#111318] text-white">{token}</option>
      ))}
    </select>
  )
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        }).catch(() => {})
      }}
      className="rounded-lg border border-white/[0.08] px-2 py-1 text-[11px] font-semibold text-white/35 hover:text-white/70"
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

function ReviewDialog({
  title,
  rows,
  warning,
  onCancel,
  onConfirm,
}: {
  title: string
  rows: Array<{ label: string; value: string }>
  warning?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-sm rounded-3xl border border-white/[0.10] bg-[#111318] p-6 shadow-2xl shadow-black/80">
        <h2 className="mb-5 text-base font-semibold text-white">{title}</h2>
        <div className="mb-5 space-y-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4">
          {rows.map((row) => (
            <div key={`${row.label}-${row.value}`} className="flex items-start justify-between gap-4 text-sm">
              <span className="text-white/35">{row.label}</span>
              <span className="max-w-[220px] break-words text-right font-semibold text-white/75">{row.value}</span>
            </div>
          ))}
        </div>
        {warning && <p className="mb-5 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-4 py-3 text-xs leading-relaxed text-amber-300/80">{warning}</p>}
        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className="flex-1 rounded-2xl border border-white/[0.08] py-3 text-sm font-semibold text-white/50 hover:text-white/80">Cancel</button>
          <button type="button" onClick={onConfirm} className="flex-1 rounded-2xl bg-blue-500 py-3 text-sm font-semibold text-white hover:bg-blue-400">Confirm</button>
        </div>
      </div>
    </div>
  )
}

type PublicStepState = 'complete' | 'active' | 'muted' | 'warning' | 'failed'

function PublicStatusTimeline({
  steps,
}: {
  steps: Array<{ key: string; label: string; state: PublicStepState }>
}) {
  const isSettled = steps.every((step) => step.state !== 'active')
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="mb-3 flex items-center gap-2">
        {!isSettled && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-400/30 border-t-blue-300" />}
        <p className="text-xs font-semibold uppercase tracking-wider text-white/35">Transaction status</p>
      </div>
      <div className="space-y-2">
        {steps.map((step) => (
          <div key={step.key} className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 rounded-full ${
              step.state === 'failed'
                ? 'bg-red-400'
                : step.state === 'warning'
                  ? 'bg-amber-400'
                  : step.state === 'complete'
                    ? 'bg-emerald-400'
                    : step.state === 'active'
                      ? 'bg-blue-400'
                      : 'bg-white/15'
            }`} />
            <span className={`text-xs ${
              step.state === 'failed'
                ? 'text-red-300'
                : step.state === 'warning'
                  ? 'text-amber-300'
                  : step.state === 'complete'
                    ? 'text-white/65'
                    : step.state === 'active'
                      ? 'text-blue-300'
                      : 'text-white/30'
            }`}>{step.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function UtilityCard({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="w-full max-w-md overflow-hidden rounded-3xl border border-white/[0.08] bg-[#111318] shadow-2xl shadow-black/60">
      <div className="p-5">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {right ?? <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-400">Arc Testnet</span>}
        </div>
        {children}
      </div>
    </div>
  )
}

function WalletGate() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
      <p className="text-sm text-white/50">Connect your wallet to continue</p>
      <ConnectButton />
    </div>
  )
}

function ChainGate() {
  const { switchChain, isPending } = useSwitchChain()
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <p className="mb-2 text-xs text-amber-400">Switch to Arc Testnet to continue.</p>
      <button type="button" onClick={() => switchChain({ chainId: ARC_TESTNET_CHAIN_ID })} disabled={isPending} className="rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/30 disabled:opacity-50">
        {isPending ? 'Switching...' : 'Switch to Arc Testnet'}
      </button>
    </div>
  )
}

function useTokenBalances() {
  const { address } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const [balances, setBalances] = useState<Record<SupportedToken, bigint | null>>({ USDC: null, EURC: null, cirBTC: null })
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!address || !publicClient || chainId !== ARC_TESTNET_CHAIN_ID) {
      setBalances({ USDC: null, EURC: null, cirBTC: null })
      return
    }
    setLoading(true)
    try {
      const results = await Promise.allSettled(
        SUPPORTED_TOKENS.map((token) => publicClient.readContract({
          address: tokenAddress(token),
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        })),
      )
      setBalances({
        USDC: results[0].status === 'fulfilled' ? results[0].value as bigint : null,
        EURC: results[1].status === 'fulfilled' ? results[1].value as bigint : null,
        cirBTC: results[2].status === 'fulfilled' ? results[2].value as bigint : null,
      })
    } finally {
      setLoading(false)
    }
  }, [address, chainId, publicClient])

  useEffect(() => {
    queueMicrotask(() => refresh().catch(() => {}))
  }, [refresh])

  return { balances, loading, refresh }
}

function SendMode({ presetToken }: { presetToken?: SupportedToken }) {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const { balances, loading, refresh } = useTokenBalances()
  const { addTransaction } = useSwapHistory()
  const { entries, addOrUpdate, remove } = useAddressBook()
  const [token, setToken] = useState<SupportedToken>(presetToken ?? 'USDC')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [label, setLabel] = useState('')
  const [status, setStatus] = useState<TxStatus>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const lockRef = useRef(false)

  useEffect(() => {
    if (presetToken) queueMicrotask(() => setToken(presetToken))
  }, [presetToken])

  const parsedAmount = parseTokenAmount(amount, token)
  const validation = useMemo(() => {
    if (!isConnected) return 'Wallet not connected.'
    if (chainId !== ARC_TESTNET_CHAIN_ID) return 'Please switch to Arc Testnet.'
    if (!walletClient || !publicClient) return 'Wallet client unavailable.'
    if (!isAddress(recipient)) return 'Enter a valid recipient address.'
    if (recipient.toLowerCase() === zeroAddress.toLowerCase()) return 'Recipient cannot be the zero address.'
    if (!parsedAmount) return 'Enter an amount greater than zero.'
    const balance = balances[token]
    if (balance !== null && parsedAmount > balance) return 'Insufficient balance.'
    return null
  }, [balances, chainId, isConnected, parsedAmount, publicClient, recipient, token, walletClient])

  const showSendStatus = status !== 'idle'
  const sendHasFailed = status === 'rejected' || status === 'error'
  const sendSteps = [
    { key: 'preparing', label: 'Preparing', state: status === 'review' ? 'active' : status === 'idle' ? 'muted' : 'complete' },
    { key: 'wallet', label: sendHasFailed && !txHash ? 'Wallet confirmation failed' : 'Wallet confirmation', state: sendHasFailed && !txHash ? 'failed' : status === 'pending' && !txHash ? 'active' : txHash || status === 'success' || status === 'verification_failed' ? 'complete' : 'muted' },
    { key: 'submitted', label: sendHasFailed && txHash ? 'Transaction failed' : 'Transaction submitted', state: sendHasFailed && txHash ? 'failed' : status === 'pending' && txHash ? 'active' : status === 'success' || status === 'verification_failed' ? 'complete' : 'muted' },
    { key: 'verified', label: status === 'verification_failed' ? 'Verification warning' : 'Verified', state: status === 'verification_failed' ? 'warning' : status === 'success' ? 'complete' : 'muted' },
  ] satisfies Array<{ key: string; label: string; state: PublicStepState }>

  async function executeSend() {
    if (validation || !address || !walletClient || !publicClient || !parsedAmount || lockRef.current) return
    lockRef.current = true
    setStatus('pending')
    setMessage(null)
    setTxHash(null)
    try {
      const meta = TOKENS[token]
      const hash = meta.isNative
        ? await walletClient.sendTransaction({ to: recipient as `0x${string}`, value: parsedAmount, account: address, chain: walletClient.chain })
        : await walletClient.sendTransaction({
            to: meta.address,
            data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [recipient as `0x${string}`, parsedAmount] }),
            account: address,
            chain: walletClient.chain,
          })
      setTxHash(hash)
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      await refresh()
      const verified = receipt.status === 'success' && (meta.isNative || decodeExpectedTransfer(receipt.logs, token, address, recipient, parsedAmount))
      const nextStatus = verified ? 'success' : 'verification_failed'
      setStatus(nextStatus)
      setMessage(verified ? 'Send verified from transfer events.' : 'Transaction confirmed, but expected transfer was not detected.')
      addTransaction({
        type: 'send',
        timestamp: nowMs(),
        chainId: ARC_TESTNET_CHAIN_ID,
        status: verified ? 'success' : 'verification_failed',
        walletAddress: address,
        token,
        amount,
        recipient,
        txHash: hash,
        verificationSummary: verified ? 'Expected transfer detected.' : 'Receipt confirmed but transfer verification failed.',
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Send failed.'
      const rejected = isUserRejection(msg)
      setStatus(rejected ? 'rejected' : 'error')
      setMessage(rejected ? 'User rejected transaction.' : msg)
      addTransaction({
        type: 'send',
        timestamp: nowMs(),
        chainId: ARC_TESTNET_CHAIN_ID,
        status: rejected ? 'rejected' : 'failed',
        walletAddress: address,
        token,
        amount,
        recipient,
        txHash: null,
        errorMessage: rejected ? 'User rejected transaction.' : msg,
      })
    } finally {
      lockRef.current = false
    }
  }

  return (
    <UtilityCard title="Send Token">
      {!isConnected ? <WalletGate /> : chainId !== ARC_TESTNET_CHAIN_ID ? <ChainGate /> : (
        <div className="space-y-4">
          {status === 'review' && (
            <ReviewDialog
              title="Review Send"
              rows={[
                { label: 'Token', value: token },
                { label: 'Amount', value: `${amount} ${token}` },
                { label: 'Recipient', value: recipient },
                { label: 'Network', value: ARC_TESTNET_NAME },
              ]}
              onCancel={() => setStatus('idle')}
              onConfirm={executeSend}
            />
          )}
          <div className="space-y-1">
            <FieldLabel>Token</FieldLabel>
            <TokenSelect value={token} onChange={setToken} disabled={status === 'pending'} />
            <p className="text-xs text-white/30">Balance: {loading ? 'loading...' : balances[token] !== null ? `${formatTokenAmount(balances[token]!, token)} ${token}` : 'unavailable'}</p>
          </div>
          <div className="space-y-1">
            <FieldLabel>Recipient</FieldLabel>
            <input value={recipient} onChange={(event) => setRecipient(event.target.value)} className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm text-white outline-none focus:border-blue-500/50" placeholder="0x..." />
            {entries.length > 0 && (
              <select value="" onChange={(event) => setRecipient(event.target.value)} className="w-full rounded-xl border border-white/[0.08] bg-white/[0.06] px-3 py-2 text-xs text-white/70 outline-none">
                <option value="" className="bg-[#111318]">Select saved address</option>
                {entries.map((entry) => <option key={entry.id} value={entry.address} className="bg-[#111318]">{entry.label} - {truncateHash(entry.address)}</option>)}
              </select>
            )}
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="space-y-1">
              <FieldLabel>Amount</FieldLabel>
              <input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" inputMode="decimal" className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-xl font-semibold text-white outline-none focus:border-blue-500/50" placeholder="0.00" />
            </div>
            <button type="button" onClick={() => { const bal = balances[token]; if (bal !== null) setAmount(formatTokenAmount(bal, token).replace(/,/g, '')) }} className="mt-6 rounded-xl border border-white/[0.08] px-3 text-xs font-semibold text-white/45 hover:text-white/75">Max</button>
          </div>
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="mb-2 flex gap-2">
              <input value={label} onChange={(event) => setLabel(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white outline-none" placeholder="Address label" />
              <button type="button" onClick={() => addOrUpdate(label, recipient)} className="rounded-lg border border-white/[0.08] px-3 py-2 text-xs font-semibold text-white/45 hover:text-white/75">Save</button>
            </div>
            <div className="max-h-24 space-y-1 overflow-auto">
              {entries.map((entry) => (
                <div key={entry.id} className="flex items-center justify-between gap-2 text-xs text-white/40">
                  <button type="button" onClick={() => setRecipient(entry.address)} className="min-w-0 truncate text-left hover:text-white/70">{entry.label}: {truncateHash(entry.address)}</button>
                  <button type="button" onClick={() => remove(entry.id)} className="text-white/25 hover:text-red-300">Delete</button>
                </div>
              ))}
            </div>
          </div>
          <PrimaryButton disabled={!!validation || status === 'pending'} onClick={() => setStatus('review')}>
            {status === 'pending' ? 'Waiting for wallet...' : 'Send'}
          </PrimaryButton>
          {showSendStatus && <PublicStatusTimeline steps={sendSteps} />}
          {validation && <p className="text-center text-xs text-white/30">{validation}</p>}
          {message && <p className={`rounded-xl border px-4 py-3 text-xs ${status === 'success' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/25 bg-amber-500/10 text-amber-300'}`}>{message}</p>}
          {txHash && <a href={explorerTxUrl(txHash)} target="_blank" rel="noopener noreferrer" className="block text-center text-xs text-blue-300/70 underline underline-offset-2">View {truncateHash(txHash)} on Arcscan</a>}
        </div>
      )}
    </UtilityCard>
  )
}

function BatchMode() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const { balances, refresh } = useTokenBalances()
  const { addTransaction } = useSwapHistory()
  const [token, setToken] = useState<SupportedToken>('USDC')
  const [rows, setRows] = useState([{ recipient: '', amount: '' }])
  const [csv, setCsv] = useState('')
  const [review, setReview] = useState(false)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<Array<{ recipient: string; status: string; txHash?: string }>>([])
  const lockRef = useRef(false)
  const parsedRows = rows.map((row) => ({ ...row, parsed: parseTokenAmount(row.amount, token) }))
  const total = parsedRows.reduce((sum, row) => sum + (row.parsed ?? BigInt(0)), BigInt(0))
  const invalid = !isConnected || chainId !== ARC_TESTNET_CHAIN_ID || !walletClient || !publicClient || parsedRows.some((row) => !isAddress(row.recipient) || row.recipient.toLowerCase() === zeroAddress.toLowerCase() || !row.parsed) || total <= BigInt(0) || (balances[token] !== null && total > balances[token])
  const showBatchStatus = review || running || results.length > 0
  const batchRejected = results.some((result) => result.status === 'rejected')
  const batchFailed = results.some((result) => result.status === 'failed')
  const batchVerificationFailed = results.some((result) => result.status === 'verification failed')
  const batchAllConfirmed = results.length === parsedRows.length && results.every((result) => result.status === 'confirmed')
  const batchSteps = [
    { key: 'preparing', label: 'Preparing', state: review ? 'active' : running || results.length > 0 ? 'complete' : 'muted' },
    { key: 'wallet', label: batchRejected ? 'Wallet confirmation failed' : 'Wallet confirmation', state: batchRejected ? 'failed' : running && results.length === 0 ? 'active' : results.length > 0 ? 'complete' : 'muted' },
    { key: 'submitted', label: batchFailed ? 'Transaction failed' : 'Transaction submitted', state: batchFailed ? 'failed' : running && results.length > 0 ? 'active' : results.length > 0 ? 'complete' : 'muted' },
    { key: 'verified', label: batchVerificationFailed ? 'Verification warning' : 'Verified', state: batchVerificationFailed ? 'warning' : batchAllConfirmed ? 'complete' : 'muted' },
  ] satisfies Array<{ key: string; label: string; state: PublicStepState }>

  function importCsv() {
    const next = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 5).map((line) => {
      const [recipient = '', amount = ''] = line.split(',').map((part) => part.trim())
      return { recipient, amount }
    })
    if (next.length > 0) setRows(next)
  }

  async function runBatch() {
    if (invalid || !address || !walletClient || !publicClient || lockRef.current) return
    lockRef.current = true
    setRunning(true)
    setReview(false)
    setResults([])
    for (const row of parsedRows) {
      if (!row.parsed) continue
      try {
        const hash = await walletClient.sendTransaction({
          to: tokenAddress(token),
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [row.recipient as `0x${string}`, row.parsed] }),
          account: address,
          chain: walletClient.chain,
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        const verified = receipt.status === 'success' && decodeExpectedTransfer(receipt.logs, token, address, row.recipient, row.parsed)
        const status = verified ? 'confirmed' : 'verification failed'
        setResults((prev) => [...prev, { recipient: row.recipient, status, txHash: hash }])
        addTransaction({
          type: 'batch_send',
          timestamp: nowMs(),
          chainId: ARC_TESTNET_CHAIN_ID,
          status: verified ? 'success' : 'verification_failed',
          walletAddress: address,
          token,
          amount: row.amount,
          recipient: row.recipient,
          txHash: hash,
          verificationSummary: verified ? 'Expected batch transfer detected.' : 'Receipt confirmed but transfer verification failed.',
        })
        if (!verified) break
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Batch transaction failed.'
        const rejected = isUserRejection(msg)
        setResults((prev) => [...prev, { recipient: row.recipient, status: rejected ? 'rejected' : 'failed' }])
        addTransaction({
          type: 'batch_send',
          timestamp: nowMs(),
          chainId: ARC_TESTNET_CHAIN_ID,
          status: rejected ? 'rejected' : 'failed',
          walletAddress: address,
          token,
          amount: row.amount,
          recipient: row.recipient,
          txHash: null,
          errorMessage: rejected ? 'User rejected transaction.' : msg,
        })
        break
      }
    }
    await refresh()
    setRunning(false)
    lockRef.current = false
  }

  return (
    <UtilityCard title="Batch Send">
      {!isConnected ? <WalletGate /> : chainId !== ARC_TESTNET_CHAIN_ID ? <ChainGate /> : (
        <div className="space-y-4">
          {review && <ReviewDialog title="Review Batch Send" rows={[{ label: 'Token', value: token }, { label: 'Recipients', value: String(rows.length) }, { label: 'Total', value: `${formatTokenAmount(total, token)} ${token}` }]} warning="Batch send v1 sends one wallet transaction per recipient." onCancel={() => setReview(false)} onConfirm={runBatch} />}
          <p className="rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-4 py-3 text-xs text-amber-300/80">Batch send v1 sends one wallet transaction per recipient.</p>
          <TokenSelect value={token} onChange={setToken} disabled={running} />
          <div className="space-y-2">
            {rows.map((row, index) => (
              <div key={index} className="grid grid-cols-[1fr_96px_28px] gap-2">
                <input value={row.recipient} onChange={(event) => setRows((prev) => prev.map((item, i) => i === index ? { ...item, recipient: event.target.value } : item))} className="min-w-0 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white outline-none" placeholder="0x recipient" />
                <input value={row.amount} onChange={(event) => setRows((prev) => prev.map((item, i) => i === index ? { ...item, amount: event.target.value } : item))} className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white outline-none" placeholder="Amount" />
                <button type="button" onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))} disabled={rows.length === 1 || running} className="rounded-lg border border-white/[0.08] text-white/35 disabled:opacity-30">x</button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => rows.length < 5 && setRows((prev) => [...prev, { recipient: '', amount: '' }])} disabled={rows.length >= 5 || running} className="w-full rounded-xl border border-white/[0.08] py-2 text-xs font-semibold text-white/45 hover:text-white/75 disabled:opacity-30">Add recipient</button>
          <textarea value={csv} onChange={(event) => setCsv(event.target.value)} className="h-20 w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white outline-none" placeholder="address,amount" />
          <button type="button" onClick={importCsv} disabled={running} className="text-xs font-semibold text-white/40 hover:text-white/70">Import CSV rows</button>
          <p className="text-xs text-white/35">Total: {formatTokenAmount(total, token)} {token}</p>
          <PrimaryButton disabled={invalid || running} onClick={() => setReview(true)}>{running ? 'Batch running...' : 'Review batch'}</PrimaryButton>
          {showBatchStatus && <PublicStatusTimeline steps={batchSteps} />}
          {results.length > 0 && <div className="space-y-2">{results.map((result, index) => <div key={`${result.recipient}-${index}`} className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs"><span className="truncate text-white/45">{truncateHash(result.recipient)}</span><span className="text-white/65">{result.status}</span></div>)}</div>}
        </div>
      )}
    </UtilityCard>
  )
}

function PortfolioMode({ setMode, setPresetToken }: { setMode: (mode: Mode) => void; setPresetToken: (token: SupportedToken) => void }) {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { balances, loading, refresh } = useTokenBalances()

  return (
    <UtilityCard title="Portfolio">
      {!isConnected ? <WalletGate /> : chainId !== ARC_TESTNET_CHAIN_ID ? <ChainGate /> : (
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
            <p className="mb-2 text-xs text-white/35">Wallet</p>
            <div className="flex items-center justify-between gap-3">
              <a href={explorerAddressUrl(address!)} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-sm font-semibold text-white/70">{address}</a>
              <CopyButton value={address!} />
            </div>
          </div>
          {SUPPORTED_TOKENS.map((token) => (
            <div key={token} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-white">{token}</span>
                <span className="text-sm text-white/60">{loading ? 'loading...' : balances[token] !== null ? formatTokenAmount(balances[token]!, token) : 'unavailable'}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button type="button" onClick={() => { setPresetToken(token); setMode('swap') }} className="rounded-xl border border-white/[0.08] py-2 text-xs font-semibold text-white/45 hover:text-white/75">Swap</button>
                <button type="button" onClick={() => { setPresetToken(token); setMode('send') }} className="rounded-xl border border-white/[0.08] py-2 text-xs font-semibold text-white/45 hover:text-white/75">Send</button>
                <button type="button" onClick={() => setPresetToken(token)} className="rounded-xl border border-white/[0.08] py-2 text-xs font-semibold text-white/45 hover:text-white/75">Max</button>
              </div>
            </div>
          ))}
          <PrimaryButton disabled={loading} onClick={refresh}>{loading ? 'Refreshing...' : 'Refresh balances'}</PrimaryButton>
          <FaucetPanel balances={balances} />
        </div>
      )}
    </UtilityCard>
  )
}

function FaucetPanel({ balances }: { balances: Record<SupportedToken, bigint | null> }) {
  const { address } = useAccount()
  const lowUsdc = balances.USDC !== null && balances.USDC < LOW_USDC_RAW
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white/70">Faucet / Top-up</h3>
        {address && <CopyButton value={address} label="Copy address" />}
      </div>
      {lowUsdc && <p className="mb-2 text-xs text-amber-300/80">Low USDC balance. Arc uses USDC for gas, so keep a small buffer.</p>}
      <p className="text-xs leading-relaxed text-white/35">Use the official Arc Testnet faucet from Circle/Arc documentation.</p>
    </div>
  )
}

function ApprovalsMode() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const { addTransaction } = useSwapHistory()
  const [allowances, setAllowances] = useState<Record<SupportedToken, bigint | null>>({ USDC: null, EURC: null, cirBTC: null })
  const [loading, setLoading] = useState(false)
  const [reviewToken, setReviewToken] = useState<SupportedToken | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!address || !publicClient || chainId !== ARC_TESTNET_CHAIN_ID) return
    setLoading(true)
    try {
      const results = await Promise.allSettled(SUPPORTED_TOKENS.map((token) => publicClient.readContract({
        address: tokenAddress(token),
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [address, CIRCLE_SWAP_ADAPTER],
      })))
      setAllowances({
        USDC: results[0].status === 'fulfilled' ? results[0].value as bigint : null,
        EURC: results[1].status === 'fulfilled' ? results[1].value as bigint : null,
        cirBTC: results[2].status === 'fulfilled' ? results[2].value as bigint : null,
      })
    } finally {
      setLoading(false)
    }
  }, [address, chainId, publicClient])

  useEffect(() => {
    queueMicrotask(() => refresh().catch(() => {}))
  }, [refresh])

  async function revoke(token: SupportedToken) {
    if (!address || !walletClient || !publicClient) return
    setReviewToken(null)
    setLoading(true)
    try {
      const hash = await walletClient.sendTransaction({
        to: tokenAddress(token),
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [CIRCLE_SWAP_ADAPTER, BigInt(0)] }),
        account: address,
        chain: walletClient.chain,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      await refresh()
      const nextAllowance = await publicClient.readContract({ address: tokenAddress(token), abi: ERC20_ABI, functionName: 'allowance', args: [address, CIRCLE_SWAP_ADAPTER] }) as bigint
      const verified = nextAllowance === BigInt(0)
      setMessage(verified ? `Revoked ${token} allowance.` : `${token} revoke confirmed, but allowance is still non-zero.`)
      addTransaction({
        type: 'revoke',
        timestamp: nowMs(),
        chainId: ARC_TESTNET_CHAIN_ID,
        status: verified ? 'success' : 'verification_failed',
        walletAddress: address,
        token,
        spender: CIRCLE_SWAP_ADAPTER,
        txHash: hash,
        verificationSummary: verified ? 'Allowance reset to zero.' : 'Allowance remained non-zero after receipt.',
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Revoke failed.'
      const rejected = isUserRejection(msg)
      setMessage(rejected ? 'User rejected revoke.' : msg)
      addTransaction({
        type: 'revoke',
        timestamp: nowMs(),
        chainId: ARC_TESTNET_CHAIN_ID,
        status: rejected ? 'rejected' : 'failed',
        walletAddress: address,
        token,
        spender: CIRCLE_SWAP_ADAPTER,
        txHash: null,
        errorMessage: rejected ? 'User rejected revoke.' : msg,
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <UtilityCard title="Approval Manager">
      {!isConnected ? <WalletGate /> : chainId !== ARC_TESTNET_CHAIN_ID ? <ChainGate /> : (
        <div className="space-y-4">
          {reviewToken && <ReviewDialog title="Review Revoke" rows={[{ label: 'Token', value: reviewToken }, { label: 'Spender', value: CIRCLE_SWAP_ADAPTER }, { label: 'Action', value: 'approve(spender, 0)' }]} onCancel={() => setReviewToken(null)} onConfirm={() => revoke(reviewToken)} />}
          <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs leading-relaxed text-white/35">Known swap spender: {truncateHash(CIRCLE_SWAP_ADAPTER)}. Unknown spenders are not shown or revoked.</p>
          {SUPPORTED_TOKENS.map((token) => {
            const allowance = allowances[token]
            return (
              <div key={token} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-white">{token}</span>
                  <span className="text-xs text-white/50">{loading ? 'loading...' : allowance !== null ? `${formatTokenAmount(allowance, token)} ${token}` : 'unavailable'}</span>
                </div>
                <button type="button" onClick={() => setReviewToken(token)} disabled={!allowance || allowance <= BigInt(0) || loading} className="w-full rounded-xl border border-white/[0.08] py-2 text-xs font-semibold text-white/45 hover:text-white/75 disabled:cursor-not-allowed disabled:opacity-30">Revoke</button>
              </div>
            )
          })}
          <PrimaryButton disabled={loading} onClick={refresh}>{loading ? 'Refreshing...' : 'Refresh allowances'}</PrimaryButton>
          {message && <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs text-white/45">{message}</p>}
        </div>
      )}
    </UtilityCard>
  )
}

function HistoryMode() {
  const { history, clearHistory, clearFailed } = useSwapHistory()
  const [filter, setFilter] = useState<'all' | TransactionType>('all')
  const filtered = filter === 'all' ? history : history.filter((entry) => (entry.type ?? 'swap') === filter)

  return (
    <UtilityCard title="Recent Transactions">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {(['all', 'swap', 'send', 'batch_send', 'revoke'] as const).map((item) => (
            <button key={item} type="button" onClick={() => setFilter(item)} className={`rounded-full border px-3 py-1 text-xs font-semibold ${filter === item ? 'border-blue-500/40 bg-blue-500/15 text-blue-300' : 'border-white/[0.08] text-white/35 hover:text-white/65'}`}>{item === 'batch_send' ? 'Batch' : item === 'all' ? 'All' : item}</button>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={clearFailed} className="rounded-xl border border-white/[0.08] px-3 py-2 text-xs font-semibold text-white/35 hover:text-white/70">Clear failed</button>
          <button type="button" onClick={clearHistory} className="rounded-xl border border-white/[0.08] px-3 py-2 text-xs font-semibold text-white/35 hover:text-white/70">Clear all</button>
        </div>
        {filtered.length === 0 ? <p className="text-sm text-white/35">No local transactions yet.</p> : <TransactionList entries={filtered} />}
      </div>
    </UtilityCard>
  )
}

function TransactionList({ entries }: { entries: SwapHistoryEntry[] }) {
  return (
    <div className="space-y-2">
      {entries.map((entry) => {
        const type = entry.type ?? 'swap'
        const txHash = entry.txHash ?? entry.swapTxHash ?? entry.approvalTxHash ?? null
        const status = String(entry.status).replace('-', '_')
        const statusClass = status === 'success'
          ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
          : status === 'verification_failed'
            ? 'border-amber-500/25 bg-amber-500/10 text-amber-300'
            : 'border-red-500/25 bg-red-500/10 text-red-300'
        return (
          <div key={entry.id} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass}`}>{status.replace('_', ' ')}</span>
              <span className="text-[10px] text-white/25">{new Date(entry.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <p className="text-xs font-semibold text-white/70">{type === 'swap' ? `${entry.tokenIn} -> ${entry.tokenOut}` : `${type.replace('_', ' ')} ${entry.amount ?? entry.amountIn ?? ''} ${entry.token ?? ''}`}</p>
            {entry.recipient && <p className="mt-1 truncate text-xs text-white/35">To {entry.recipient}</p>}
            {entry.verificationSummary && <p className="mt-1 text-xs text-white/35">{entry.verificationSummary}</p>}
            {txHash && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <a href={`/tx/${txHash}`} className="text-[11px] text-blue-300/70 underline underline-offset-2">Receipt</a>
                <a href={explorerTxUrl(txHash)} target="_blank" rel="noopener noreferrer" className="text-[11px] text-emerald-500/70 underline underline-offset-2">Arcscan {truncateHash(txHash)}</a>
                <CopyButton value={txHash} label="Copy tx" />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function TransactionDashboard() {
  const [mode, setMode] = useState<Mode>('swap')
  const [presetToken, setPresetToken] = useState<SupportedToken>('USDC')

  return (
    <div className="flex w-full flex-col items-center">
      <div className="mb-5 flex w-full max-w-md flex-wrap gap-2 rounded-2xl border border-white/[0.08] bg-[#111318] p-2">
        {MODE_LABELS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => setMode(item.value)}
            className={`flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition-colors ${mode === item.value ? 'bg-blue-500/20 text-blue-200' : 'text-white/35 hover:bg-white/[0.04] hover:text-white/70'}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {mode === 'swap' && <CircleSwapBox />}
      {mode === 'send' && <SendMode presetToken={presetToken} />}
      {mode === 'batch' && <BatchMode />}
      {mode === 'portfolio' && <PortfolioMode setMode={setMode} setPresetToken={setPresetToken} />}
      {mode === 'approvals' && <ApprovalsMode />}
      {mode === 'history' && <HistoryMode />}
    </div>
  )
}
