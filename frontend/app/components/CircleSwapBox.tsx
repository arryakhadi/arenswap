'use client'

/**
 * CircleSwapBox — same-chain token swap on Arc Testnet via Circle Swap Kit.
 *
 * Architecture:
 *   1. User fills form and clicks "Swap" → review modal appears.
 *   2. User confirms in modal → handleConfirmedSwap() is called (only here).
 *   3. Browser POSTs to /api/circle/swap (Next.js server proxy).
 *   4. Server calls Circle's createSwap API (no CORS issue server-side).
 *   5. Server returns the EVM transaction payload.
 *   6. Browser checks on-chain allowance, approves only if needed, then
 *      executes the swap using the user's connected wallet.
 *   7. Success is recorded in localStorage swap history.
 *
 * No private key is used. No Circle API key is exposed to the browser.
 *
 * MetaMask confirmation flow:
 *   First-time swap:  1 approval  +  1 swap  =  2 confirmations
 *   Repeat swap:      0 approvals +  1 swap  =  1 confirmation
 */

import { useCallback, useEffect, useRef, useState, startTransition } from 'react'
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { encodeFunctionData, formatUnits } from 'viem'
import { useSwapHistory } from '@/app/hooks/useSwapHistory'
import type { SwapHistoryEntry } from '@/app/hooks/useSwapHistory'

// ─── Constants ─────────────────────────────────────────────────────────────────

const ARC_TESTNET_CHAIN_ID = 5042002
const ARC_TESTNET_EXPLORER = 'https://testnet.arcscan.app'
const ARC_TESTNET_NAME = 'Arc Testnet'

const SUPPORTED_TOKENS = ['USDC', 'EURC', 'cirBTC'] as const
type SupportedToken = (typeof SUPPORTED_TOKENS)[number]

const TOKEN_DECIMALS: Record<SupportedToken, number> = {
  USDC:   6,
  EURC:   6,
  cirBTC: 8,
}

const TOKEN_ADDRESSES: Record<SupportedToken, `0x${string}`> = {
  USDC:   '0x3600000000000000000000000000000000000000',
  EURC:   '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  cirBTC: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
}

// Leave 0.5 USDC as gas buffer when using Max (Arc uses USDC as native gas)
const GAS_BUFFER_USDC = 0.5

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// ─── Phase ────────────────────────────────────────────────────────────────────

type Phase =
  | 'idle'
  | 'preparing'
  | 'checking-allowance'
  | 'waiting-approval'
  | 'approval-confirmed'
  | 'waiting-swap'
  | 'success'
  | 'error'

const PHASE_LABELS: Record<Phase, string> = {
  'idle':               '',
  'preparing':          'Preparing swap\u2026',
  'checking-allowance': 'Checking token allowance\u2026',
  'waiting-approval':   'Confirm approval in your wallet\u2026',
  'approval-confirmed': 'Approval confirmed. Preparing swap\u2026',
  'waiting-swap':       'Confirm swap in your wallet\u2026',
  'success':            'Swap successful!',
  'error':              '',
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface SwapInstruction {
  target: string
  data: string
  value: string
  tokenIn: string
  amountToApprove: string
  tokenOut: string
  minTokenOut: string
}

interface SwapTransaction {
  signature?: string
  executionParams?: {
    execId: string
    deadline: string
    metadata: string
    tokens: Array<{ token: string; beneficiary: string }>
    instructions: SwapInstruction[]
  }
  gasLimit?: string
}

interface ProxyResponse {
  ok: boolean
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountBaseUnits: string
  estimatedAmount: string
  stopLimit: string
  fromAddress: string
  toAddress: string
  transaction: SwapTransaction
  fees: unknown
  error?: string
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isValidAmount(value: string): boolean {
  const n = parseFloat(value)
  return value.trim() !== '' && isFinite(n) && n > 0
}

function isUserRejection(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('user rejected') ||
    lower.includes('user denied') ||
    lower.includes('rejected the request') ||
    lower.includes('action_rejected') ||
    lower.includes('eth_requestaccounts') ||
    lower.includes('cancelled')
  )
}

function isUnsupportedPairError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('not supported') ||
    lower.includes('unsupported') ||
    lower.includes('no route') ||
    lower.includes('invalid token') ||
    lower.includes('pair')
  )
}

function truncateHash(hash: string, chars = 8): string {
  return `${hash.slice(0, chars + 2)}\u2026${hash.slice(-4)}`
}

function formatBalance(raw: bigint, decimals: number): string {
  const s = formatUnits(raw, decimals)
  const n = parseFloat(s)
  if (n === 0) return '0'
  if (n < 0.0001) return '< 0.0001'
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

function Spinner({ size = 4 }: { size?: number }) {
  const cls = `animate-spin h-${size} w-${size}`
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  )
}

// ─── Token selector ───────────────────────────────────────────────────────────

interface TokenSelectProps {
  label: string
  value: SupportedToken
  onChange: (v: SupportedToken) => void
  exclude?: SupportedToken
  disabled?: boolean
  balance?: string | null
  balanceLoading?: boolean
  onMax?: () => void
}

function TokenSelect({
  label, value, onChange, exclude, disabled,
  balance, balanceLoading, onMax,
}: TokenSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium uppercase tracking-wider text-white/40">
          {label}
        </label>
        {balance !== undefined && (
          <span className="text-xs text-white/30">
            {balanceLoading ? (
              <span className="opacity-50">loading\u2026</span>
            ) : balance !== null ? (
              <>{balance} {value}</>
            ) : (
              <span className="opacity-40">unavailable</span>
            )}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as SupportedToken)}
          disabled={disabled}
          className="flex-1 rounded-xl border border-white/[0.08] bg-white/[0.06] px-3 py-2.5 text-sm font-semibold text-white outline-none transition-colors hover:border-white/[0.14] focus:border-blue-500/50 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Select ${label} token`}
        >
          {SUPPORTED_TOKENS.filter((t) => t !== exclude).map((t) => (
            <option key={t} value={t} className="bg-[#111318] text-white">{t}</option>
          ))}
        </select>
        {onMax && (
          <button
            type="button"
            onClick={onMax}
            disabled={disabled || balance === null || balance === undefined}
            className="rounded-xl border border-white/[0.08] bg-white/[0.06] px-3 py-2 text-xs font-semibold text-white/60 transition-colors hover:border-white/[0.14] hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Use maximum balance"
          >
            Max
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Review Modal ─────────────────────────────────────────────────────────────

interface ReviewModalProps {
  tokenIn: SupportedToken
  tokenOut: SupportedToken
  amountIn: string
  address: string
  onConfirm: () => void
  onCancel: () => void
}

function ReviewModal({ tokenIn, tokenOut, amountIn, address, onConfirm, onCancel }: ReviewModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-modal-title"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-sm rounded-3xl border border-white/[0.10] bg-[#111318] shadow-2xl shadow-black/80">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-3xl"
          style={{ background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.6) 40%, rgba(99,102,241,0.6) 60%, transparent)' }}
          aria-hidden="true"
        />
        <div className="p-6">
          <h2 id="review-modal-title" className="mb-5 text-base font-semibold text-white">
            Review Swap
          </h2>
          <div className="mb-5 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4 space-y-3">
            <ModalRow label="You pay"    value={`${amountIn} ${tokenIn}`} highlight />
            <ModalRow label="You receive" value={`${tokenOut} (estimated on-chain)`} />
            <div className="border-t border-white/[0.06] pt-3 space-y-2">
              <ModalRow label="Network"  value={ARC_TESTNET_NAME} />
              <ModalRow label="Chain ID" value={String(ARC_TESTNET_CHAIN_ID)} />
              <ModalRow label="Wallet"   value={`${address.slice(0, 6)}\u2026${address.slice(-4)}`} />
            </div>
          </div>
          <div className="mb-5 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-4 py-3">
            <p className="text-xs text-amber-300/80 leading-relaxed">
              <span className="font-semibold text-amber-300">Arc Testnet only.</span>{' '}
              Your wallet may ask for two confirmations: first an approval, then the swap.
            </p>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 rounded-2xl border border-white/[0.08] py-3 text-sm font-semibold text-white/50 transition-colors hover:border-white/[0.14] hover:text-white/80"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="flex-1 rounded-2xl bg-gradient-to-r from-blue-500 to-indigo-600 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 transition-all hover:from-blue-400 hover:to-indigo-500 active:scale-[0.98]"
            >
              Confirm Swap
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ModalRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-white/40 shrink-0">{label}</span>
      <span className={`text-xs font-medium text-right ${highlight ? 'text-white' : 'text-white/70'}`}>
        {value}
      </span>
    </div>
  )
}

// ─── Success Card ─────────────────────────────────────────────────────────────

interface SuccessCardProps {
  tokenIn: SupportedToken
  tokenOut: SupportedToken
  amountIn: string
  estimatedOut: string | null
  approveTxHash: string | null
  swapTxHash: string
}

function SuccessCard({ tokenIn, tokenOut, amountIn, estimatedOut, approveTxHash, swapTxHash }: SuccessCardProps) {
  const [copied, setCopied] = useState(false)

  function copyHash() {
    navigator.clipboard.writeText(swapTxHash).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <svg className="h-4 w-4 text-emerald-400 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
        </svg>
        <p className="text-sm font-semibold text-emerald-400">Swap successful!</p>
      </div>
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-white/40">Swapped</span>
          <span className="text-white/70 font-medium">{amountIn} {tokenIn} &rarr; {tokenOut}</span>
        </div>
        {estimatedOut && (
          <div className="flex items-center justify-between">
            <span className="text-white/40">Est. received</span>
            <span className="text-white/70 font-medium">{estimatedOut} {tokenOut}</span>
          </div>
        )}
        {approveTxHash && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-white/40 shrink-0">Approval</span>
            <a
              href={`${ARC_TESTNET_EXPLORER}/tx/${approveTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-white/40 underline underline-offset-2 hover:text-white/60 truncate max-w-[160px]"
            >
              {truncateHash(approveTxHash)}
            </a>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-white/40 shrink-0">Swap Tx</span>
          <div className="flex items-center gap-1.5 min-w-0">
            <a
              href={`${ARC_TESTNET_EXPLORER}/tx/${swapTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300 truncate max-w-[140px]"
            >
              {truncateHash(swapTxHash)}
            </a>
            <button
              type="button"
              onClick={copyHash}
              aria-label="Copy swap transaction hash"
              className="shrink-0 rounded-md p-1 text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/60"
            >
              {copied ? (
                <svg className="h-3.5 w-3.5 text-emerald-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                  <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Recent Swaps ─────────────────────────────────────────────────────────────

interface RecentSwapsProps {
  history: SwapHistoryEntry[]
  onClear: () => void
}

function RecentSwaps({ history, onClear }: RecentSwapsProps) {
  if (history.length === 0) return null
  return (
    <div className="mt-6 w-full">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/60">Recent Swaps</h3>
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-white/20 transition-colors hover:text-white/50"
        >
          Clear
        </button>
      </div>
      <div className="space-y-2">
        {history.map((entry) => (
          <div key={entry.id} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-white/70">
                {entry.amountIn} {entry.tokenIn} &rarr; {entry.tokenOut}
              </span>
              <span className="text-[10px] text-white/25">
                {new Date(entry.timestamp).toLocaleString(undefined, {
                  month: 'short', day: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
              </span>
            </div>
            {entry.estimatedOut && (
              <p className="text-[11px] text-white/40 mb-1.5">
                Est. received: {entry.estimatedOut} {entry.tokenOut}
              </p>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              {entry.approveTxHash && (
                <a
                  href={`${ARC_TESTNET_EXPLORER}/tx/${entry.approveTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-white/30 underline underline-offset-2 hover:text-white/50"
                >
                  Approval &nearr;
                </a>
              )}
              <a
                href={`${ARC_TESTNET_EXPLORER}/tx/${entry.swapTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-emerald-500/70 underline underline-offset-2 hover:text-emerald-400"
              >
                Swap Tx &nearr;
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function CircleSwapBox() {
  const { isConnected, address } = useAccount()
  const chainId = useChainId()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const { history, addEntry, clearHistory } = useSwapHistory()

  const [tokenIn, setTokenIn] = useState<SupportedToken>('USDC')
  const [tokenOut, setTokenOut] = useState<SupportedToken>('EURC')
  const [amountIn, setAmountIn] = useState('')

  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [approveTxHash, setApproveTxHash] = useState<string | null>(null)
  const [swapTxHash, setSwapTxHash] = useState<string | null>(null)
  const [estimatedOut, setEstimatedOut] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)

  const [balance, setBalance] = useState<string | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)

  // Synchronous duplicate-submit lock
  const isSwappingRef = useRef(false)
  // Synchronous phase ref for catch blocks
  const phaseRef = useRef<Phase>('idle')

  const isActive =
    phase === 'preparing' ||
    phase === 'checking-allowance' ||
    phase === 'waiting-approval' ||
    phase === 'approval-confirmed' ||
    phase === 'waiting-swap'

  // Kit key format hint (public env var only — real key stays server-side)
  const publicKitKey = process.env.NEXT_PUBLIC_CIRCLE_KIT_KEY
  const kitKeyMissing = publicKitKey !== undefined && publicKitKey === ''
  const kitKeyInvalidFormat =
    publicKitKey !== undefined &&
    publicKitKey !== '' &&
    !publicKitKey.startsWith('KIT_KEY:')

  // ─── Balance fetch ──────────────────────────────────────────────────────────

  const fetchBalance = useCallback(async () => {
    if (!address || !publicClient || chainId !== ARC_TESTNET_CHAIN_ID) {
      startTransition(() => setBalance(null))
      return
    }
    startTransition(() => setBalanceLoading(true))
    try {
      const raw = await publicClient.readContract({
        address: TOKEN_ADDRESSES[tokenIn],
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      })
      startTransition(() => setBalance(formatBalance(raw as bigint, TOKEN_DECIMALS[tokenIn])))
    } catch {
      startTransition(() => setBalance(null))
    } finally {
      startTransition(() => setBalanceLoading(false))
    }
  }, [address, publicClient, chainId, tokenIn])

  useEffect(() => {
    let cancelled = false
    fetchBalance().then(() => { if (cancelled) return }).catch(() => {})
    return () => { cancelled = true }
  }, [fetchBalance])

  // ─── Max button ─────────────────────────────────────────────────────────────

  function handleMax() {
    if (!balance) return
    const n = parseFloat(balance.replace(/,/g, ''))
    if (!isFinite(n) || n <= 0) return
    const safe = tokenIn === 'USDC' ? Math.max(0, n - GAS_BUFFER_USDC) : n
    if (safe <= 0) return
    setAmountIn(safe.toFixed(TOKEN_DECIMALS[tokenIn] > 6 ? 8 : 6))
    resetForm()
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  function getValidationError(): string | null {
    if (!isConnected) return 'Wallet not connected.'
    if (chainId !== ARC_TESTNET_CHAIN_ID) return 'Please switch to Arc Testnet.'
    if (!walletClient) return 'Wallet client unavailable. Try reconnecting.'
    if (tokenIn === tokenOut) return 'Select different tokens.'
    if (!isValidAmount(amountIn)) return 'Enter a valid amount greater than zero.'
    return null
  }

  const validationError = getValidationError()
  const canOpenModal = validationError === null && !isActive

  // ─── Reset ──────────────────────────────────────────────────────────────────

  function setPhaseSync(p: Phase) {
    phaseRef.current = p
    setPhase(p)
  }

  function resetForm() {
    setError(null)
    setApproveTxHash(null)
    setSwapTxHash(null)
    setEstimatedOut(null)
    setPhaseSync('idle')
  }

  // ─── Open modal ─────────────────────────────────────────────────────────────

  function handleSwapButtonClick() {
    if (!canOpenModal) return
    setShowModal(true)
  }

  function handleModalCancel() {
    setShowModal(false)
  }

  // ─── Confirmed swap — called ONLY from modal confirm button ─────────────────

  async function handleConfirmedSwap() {
    if (isSwappingRef.current) return
    if (!canOpenModal || !walletClient || !address || !publicClient) return

    isSwappingRef.current = true
    setShowModal(false)
    resetForm()
    setPhaseSync('preparing')

    try {
      // Step 1: Get EVM payload from server proxy
      const res = await fetch('/api/circle/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenIn, tokenOut, amountIn,
          fromAddress: address, toAddress: address,
          chain: 'Arc_Testnet',
        }),
      })

      const data: ProxyResponse = await res.json()

      if (!res.ok || !data.ok) {
        const msg = data.error ?? `Server error ${res.status}`
        throw new Error(
          isUnsupportedPairError(msg)
            ? 'This token pair is not currently supported on Arc Testnet.'
            : msg
        )
      }

      setEstimatedOut(data.estimatedAmount)

      const tx = data.transaction as SwapTransaction
      if (!tx?.executionParams?.instructions?.length) {
        throw new Error('Circle returned an empty transaction payload.')
      }

      // Only process the first instruction (same-chain swap = one instruction)
      const instruction = tx.executionParams.instructions[0]
      const { target, data: calldata, value: hexValue, tokenIn: instrTokenIn, amountToApprove } = instruction

      // Step 2: Check allowance — approve only if needed
      const requiredAmount = amountToApprove ? BigInt(amountToApprove) : BigInt(0)
      let finalApproveTxHash: string | null = null

      if (instrTokenIn && requiredAmount > BigInt(0)) {
        setPhaseSync('checking-allowance')

        let currentAllowance = BigInt(0)
        try {
          const result = await publicClient.readContract({
            address: instrTokenIn as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [address, target as `0x${string}`],
          })
          currentAllowance = result as bigint
        } catch {
          currentAllowance = BigInt(0)
        }

        if (currentAllowance < requiredAmount) {
          setPhaseSync('waiting-approval')

          const approveData = encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [target as `0x${string}`, requiredAmount],
          })

          const approveTx = await walletClient.sendTransaction({
            to: instrTokenIn as `0x${string}`,
            data: approveData,
            account: address,
            chain: walletClient.chain,
          })

          finalApproveTxHash = approveTx
          setApproveTxHash(approveTx)
          await publicClient.waitForTransactionReceipt({ hash: approveTx })
          setPhaseSync('approval-confirmed')
        }
      }

      // Step 3: Execute swap
      setPhaseSync('waiting-swap')

      const txValue = hexValue && hexValue !== '0x' ? BigInt(hexValue) : BigInt(0)

      const finalTxHash = await walletClient.sendTransaction({
        to: target as `0x${string}`,
        data: calldata as `0x${string}`,
        value: txValue,
        account: address,
        chain: walletClient.chain,
      })

      setSwapTxHash(finalTxHash)
      await publicClient.waitForTransactionReceipt({ hash: finalTxHash })
      setPhaseSync('success')

      // Step 4: Record in history
      addEntry({
        timestamp: Date.now(),
        chainId: ARC_TESTNET_CHAIN_ID,
        tokenIn, tokenOut, amountIn,
        estimatedOut: data.estimatedAmount ?? null,
        approveTxHash: finalApproveTxHash,
        swapTxHash: finalTxHash,
      })

      fetchBalance()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.'
      if (isUserRejection(message)) {
        const p = phaseRef.current
        const wasApproving = p === 'waiting-approval' || p === 'checking-allowance'
        setError(wasApproving ? 'Approval rejected.' : 'Swap rejected.')
      } else {
        setError(message)
      }
      setPhaseSync('error')
    } finally {
      isSwappingRef.current = false
    }
  }

  const isDev = process.env.NODE_ENV === 'development'

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {showModal && address && (
        <ReviewModal
          tokenIn={tokenIn}
          tokenOut={tokenOut}
          amountIn={amountIn}
          address={address}
          onConfirm={handleConfirmedSwap}
          onCancel={handleModalCancel}
        />
      )}

      <div className="flex flex-col items-center w-full max-w-md">
        {/* Swap card */}
        <div className="w-full relative overflow-hidden rounded-3xl border border-white/[0.08] bg-[#111318] shadow-2xl shadow-black/60">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-px"
            style={{ background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.5) 40%, rgba(99,102,241,0.5) 60%, transparent)' }}
            aria-hidden="true"
          />

          <div className="p-5">
            {/* Header */}
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Swap</h2>
              <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-400">
                Arc Testnet
              </span>
            </div>

            {/* Kit key banners */}
            {kitKeyMissing && (
              <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <p className="text-xs font-semibold text-amber-400">
                  Missing <code className="font-mono">NEXT_PUBLIC_CIRCLE_KIT_KEY</code>
                </p>
                <p className="mt-1 text-xs text-amber-300/80">Add it in Vercel Environment Variables and redeploy.</p>
              </div>
            )}
            {kitKeyInvalidFormat && (
              <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
                <p className="text-xs font-semibold text-red-400">Invalid Circle Kit Key format</p>
                <p className="mt-1 text-xs text-red-300/80">Expected: KIT_KEY:&#123;keyId&#125;:&#123;keySecret&#125;</p>
              </div>
            )}

            {/* Connect wallet */}
            {!isConnected && (
              <div className="mb-4 flex flex-col items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                <p className="text-sm text-white/50">Connect your wallet to swap</p>
                <ConnectButton />
              </div>
            )}

            {/* Wrong chain */}
            {isConnected && chainId !== ARC_TESTNET_CHAIN_ID && (
              <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <p className="mb-2 text-xs text-amber-400">Switch to Arc Testnet to continue.</p>
                <button
                  type="button"
                  onClick={() => switchChain({ chainId: ARC_TESTNET_CHAIN_ID })}
                  disabled={isSwitching}
                  className="flex items-center gap-2 rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-300 transition-colors hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSwitching && <Spinner />}
                  Switch to Arc Testnet
                </button>
              </div>
            )}

            {/* Form */}
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <TokenSelect
                  label="From"
                  value={tokenIn}
                  onChange={(v) => { setTokenIn(v); resetForm() }}
                  exclude={tokenOut}
                  disabled={isActive}
                  balance={isConnected && chainId === ARC_TESTNET_CHAIN_ID ? balance : undefined}
                  balanceLoading={balanceLoading}
                  onMax={isConnected && chainId === ARC_TESTNET_CHAIN_ID ? handleMax : undefined}
                />
                <TokenSelect
                  label="To"
                  value={tokenOut}
                  onChange={(v) => { setTokenOut(v); resetForm() }}
                  exclude={tokenIn}
                  disabled={isActive}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="circle-amount-in"
                  className="text-xs font-medium uppercase tracking-wider text-white/40"
                >
                  Amount
                </label>
                <input
                  id="circle-amount-in"
                  type="number"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amountIn}
                  onChange={(e) => { setAmountIn(e.target.value); resetForm() }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
                  disabled={isActive}
                  min="0"
                  step="any"
                  aria-label={`Amount of ${tokenIn} to swap`}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-xl font-semibold text-white outline-none placeholder:text-white/20 transition-colors hover:border-white/[0.14] focus:border-blue-500/50 focus:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
              </div>

              {/* Phase indicator */}
              {isActive && PHASE_LABELS[phase] && (
                <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
                  <Spinner />
                  <p className="text-xs text-white/50">{PHASE_LABELS[phase]}</p>
                </div>
              )}

              {/* Swap button */}
              <button
                type="button"
                onClick={handleSwapButtonClick}
                disabled={!canOpenModal}
                aria-label={`Swap ${tokenIn} for ${tokenOut}`}
                className={`w-full rounded-2xl py-4 text-base font-semibold tracking-wide transition-all duration-200 ${
                  canOpenModal
                    ? 'bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-500/25 hover:from-blue-400 hover:to-indigo-500 hover:shadow-blue-500/40 active:scale-[0.98]'
                    : 'cursor-not-allowed bg-white/[0.06] text-white/25'
                }`}
              >
                {isActive ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner />
                    {phase === 'preparing' || phase === 'checking-allowance'
                      ? 'Preparing\u2026'
                      : phase === 'waiting-approval'
                        ? 'Approve in wallet\u2026'
                        : phase === 'approval-confirmed'
                          ? 'Approved\u2026'
                          : 'Confirm in wallet\u2026'}
                  </span>
                ) : (
                  `Swap ${tokenIn} \u2192 ${tokenOut}`
                )}
              </button>

              {/* Validation hint */}
              {validationError && !error && isConnected && chainId === ARC_TESTNET_CHAIN_ID && (
                <p className="text-center text-xs text-white/30">{validationError}</p>
              )}
            </div>

            {/* Error */}
            {phase === 'error' && error && (
              <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
                <p className="text-xs font-semibold text-red-400">
                  {error.includes('rejected') || error.includes('not currently supported')
                    ? error
                    : 'Swap failed'}
                </p>
                {!error.includes('rejected') && !error.includes('not currently supported') && (
                  <p className="mt-1 text-xs text-red-300/70">{error}</p>
                )}
              </div>
            )}

            {/* Success */}
            {phase === 'success' && swapTxHash && (
              <SuccessCard
                tokenIn={tokenIn}
                tokenOut={tokenOut}
                amountIn={amountIn}
                estimatedOut={estimatedOut}
                approveTxHash={approveTxHash}
                swapTxHash={swapTxHash}
              />
            )}

            {/* Dev debug */}
            {isDev && (
              <details className="mt-4">
                <summary className="cursor-pointer text-xs text-white/20 hover:text-white/40">
                  Debug (dev only)
                </summary>
                <pre className="mt-2 rounded-lg bg-white/[0.03] p-3 text-[10px] text-white/40 overflow-auto max-h-48">
                  {JSON.stringify({ address, chainId, tokenIn, tokenOut, amountIn, phase, approveTxHash, swapTxHash, error }, null, 2)}
                </pre>
              </details>
            )}
          </div>
        </div>

        {/* Recent swaps */}
        <RecentSwaps history={history} onClear={clearHistory} />

        <p className="mt-6 text-center text-xs text-white/20">
          Powered by{' '}
          <a
            href="https://developers.circle.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/30 underline-offset-2 hover:text-white/50 hover:underline"
          >
            Circle Swap Kit
          </a>{' '}
          &middot; Arc Testnet only
        </p>
      </div>
    </>
  )
}
