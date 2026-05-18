'use client'

/**
 * CircleSwapBox — same-chain token swap on Arc Testnet via Circle Swap Kit.
 *
 * Swap verification flow:
 *   1. Snapshot raw bigint balances for tokenIn and tokenOut BEFORE swap.
 *   2. Execute swap transaction and wait for receipt.
 *   3. Decode ERC-20 Transfer events from receipt logs to detect actual transfers.
 *   4. Wait 1.5 s for RPC indexing, then re-read balances.
 *   5. Compute deltas: tokenInDelta = before - after, tokenOutDelta = after - before.
 *   6. Mark as "success" only if tokenInDelta > 0 AND tokenOutDelta > 0.
 *   7. If receipt succeeded but no balance change detected, show distinct warning.
 *
 * No private key is used. No Circle API key is exposed to the browser.
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
import { encodeFunctionData, formatUnits, decodeEventLog } from 'viem'
import { useSwapHistory } from '@/app/hooks/useSwapHistory'
import type { SwapHistoryEntry } from '@/app/hooks/useSwapHistory'

// ─── Constants ─────────────────────────────────────────────────────────────────

const ARC_TESTNET_CHAIN_ID = 5042002
const ARC_TESTNET_EXPLORER = 'https://testnet.arcscan.app'
const ARC_TESTNET_NAME = 'Arc Testnet'
const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const SUPPORTED_TOKENS = ['USDC', 'EURC', 'cirBTC'] as const
type SupportedToken = (typeof SUPPORTED_TOKENS)[number]

const TOKEN_DECIMALS: Record<SupportedToken, number> = {
  USDC:   6,
  EURC:   6,
  cirBTC: 8,
}

// Canonical ERC-20 addresses on Arc Testnet (from Circle SDK token registry)
const TOKEN_ADDRESSES: Record<SupportedToken, `0x${string}`> = {
  USDC:   '0x3600000000000000000000000000000000000000',
  EURC:   '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  cirBTC: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
}

// Leave 0.5 USDC as gas buffer when using Max (Arc uses USDC as native gas)
const GAS_BUFFER_USDC = 0.5

// ─── Arc Testnet adapter contract ─────────────────────────────────────────────
// The Circle Swap Kit routes swaps through an Adapter Contract that:
//   1. Receives the swap calldata and Circle's server signature
//   2. Handles token approvals / permit inputs
//   3. Calls the DEX router on behalf of the user
//
// For USDC→X swaps on Arc, USDC is the native gas token (18 decimals).
// The adapter's execute() is payable — the input USDC amount must be sent
// as msg.value in native wei (18 decimals), NOT as an ERC-20 transfer.
//
// Source: Circle SDK — ADAPTER_CONTRACT_EVM_TESTNET
const ADAPTER_CONTRACT = '0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b' as const

// Adapter Contract ABI — only the execute() function we call
// Source: Circle SDK adapterContractAbi
const ADAPTER_ABI = [
  {
    type: 'function' as const,
    name: 'execute',
    stateMutability: 'payable' as const,
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {
            name: 'instructions',
            type: 'tuple[]',
            components: [
              { name: 'target',          type: 'address' },
              { name: 'data',            type: 'bytes'   },
              { name: 'value',           type: 'uint256' },
              { name: 'tokenIn',         type: 'address' },
              { name: 'amountToApprove', type: 'uint256' },
              { name: 'tokenOut',        type: 'address' },
              { name: 'minTokenOut',     type: 'uint256' },
            ],
          },
          {
            name: 'tokens',
            type: 'tuple[]',
            components: [
              { name: 'token',       type: 'address' },
              { name: 'beneficiary', type: 'address' },
            ],
          },
          { name: 'execId',   type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'metadata', type: 'bytes'   },
        ],
      },
      {
        name: 'tokenInputs',
        type: 'tuple[]',
        components: [
          { name: 'permitType',     type: 'uint8'   },
          { name: 'token',          type: 'address' },
          { name: 'amount',         type: 'uint256' },
          { name: 'permitCalldata', type: 'bytes'   },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

// ERC-20 Transfer event topic0
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const

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
  {
    name: 'Transfer',
    type: 'event' as const,
    inputs: [
      { name: 'from',  type: 'address', indexed: true },
      { name: 'to',    type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

// ─── Phase ────────────────────────────────────────────────────────────────────

type Phase =
  | 'idle'
  | 'preparing'
  | 'checking-allowance'
  | 'approval-skipped'
  | 'waiting-approval'
  | 'approval-confirmed'
  | 'waiting-swap'
  | 'verifying'
  | 'success'
  | 'confirmed-no-delta'   // tx confirmed but no balance change detected
  | 'error'

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
  tokenInAddress: string
  tokenInChain: string
  tokenOutAddress: string
  tokenOutChain: string
  tokenOutDecimals: number
  amountIn: string
  amount: string
  amountBaseUnits: string
  estimatedAmount: string | null
  estimatedAmountFormatted: string | null
  stopLimit: string
  fromAddress: string
  toAddress: string
  transaction: SwapTransaction
  fees: unknown
  error?: string
}

interface BalanceSnapshot {
  rawIn: bigint
  rawOut: bigint
}

interface VerificationResult {
  deltaIn: bigint        // tokenIn spent (positive = decreased)
  deltaOut: bigint       // tokenOut received (positive = increased)
  deltaInFormatted: string
  deltaOutFormatted: string
  balanceInAfter: bigint
  balanceOutAfter: bigint
  balanceInFormatted: string
  balanceOutFormatted: string
  transfersDetected: boolean
  transferInAmount: string | null   // from Transfer event logs
  transferOutAmount: string | null
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

function isCircleApiError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('circle api') ||
    lower.includes('circle stablecoin') ||
    lower.includes('stablecoinkits') ||
    lower.includes('network error reaching circle') ||
    lower.includes('server error') ||
    lower.includes('empty transaction payload')
  )
}

function formatErrorMessage(message: string, phase: Phase): string {
  if (isUnsupportedPairError(message) || isCircleApiError(message)) {
    return 'This pair is temporarily unavailable on Arc Testnet.'
  }
  if (message.toLowerCase().includes('insufficient')) return 'Insufficient balance.'
  if (phase === 'confirmed-no-delta' || message.toLowerCase().includes('verification')) {
    return 'Verification failed. Check transfer events on the explorer.'
  }
  if (process.env.NODE_ENV === 'production') return 'Swap failed. Please try again.'
  return message
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

function formatDelta(raw: bigint, decimals: number): string {
  if (raw === BigInt(0)) return '0'
  const s = formatUnits(raw < BigInt(0) ? -raw : raw, decimals)
  const n = parseFloat(s)
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

function computeRate(amountIn: string, estimatedOut: string | null): string | null {
  if (!estimatedOut || !isValidAmount(amountIn)) return null
  const input = parseFloat(amountIn.replace(/,/g, ''))
  const output = parseFloat(estimatedOut.replace(/,/g, ''))
  if (!isFinite(input) || !isFinite(output) || input <= 0 || output <= 0) return null
  return (output / input).toLocaleString(undefined, { maximumFractionDigits: 8 })
}

function parseAmountToBaseUnits(value: string, decimals: number): bigint | null {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const [wholePart, fractionalPart = ''] = trimmed.split('.')
  if (fractionalPart.length > decimals) return null
  const paddedFraction = fractionalPart.padEnd(decimals, '0')
  try {
    return BigInt(wholePart || '0') * BigInt(10) ** BigInt(decimals) + BigInt(paddedFraction || '0')
  } catch {
    return null
  }
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
        <label className="text-xs font-medium uppercase tracking-wider text-white/40">{label}</label>
        {balance !== undefined && (
          <span className="text-xs text-white/30">
            {balanceLoading
              ? <span className="opacity-50">loading\u2026</span>
              : balance !== null
                ? <>{balance} {value}</>
                : <span className="opacity-40">unavailable</span>}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="review-modal-title">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} aria-hidden="true" />
      <div className="relative w-full max-w-sm rounded-3xl border border-white/[0.10] bg-[#111318] shadow-2xl shadow-black/80">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-3xl" style={{ background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.6) 40%, rgba(99,102,241,0.6) 60%, transparent)' }} aria-hidden="true" />
        <div className="p-6">
          <h2 id="review-modal-title" className="mb-5 text-base font-semibold text-white">Review Swap</h2>
          <div className="mb-5 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4 space-y-3">
            <ModalRow label="You pay"     value={`${amountIn} ${tokenIn}`} highlight />
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
            <button type="button" onClick={onCancel} className="flex-1 rounded-2xl border border-white/[0.08] py-3 text-sm font-semibold text-white/50 transition-colors hover:border-white/[0.14] hover:text-white/80">Cancel</button>
            <button type="button" onClick={onConfirm} className="flex-1 rounded-2xl bg-gradient-to-r from-blue-500 to-indigo-600 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 transition-all hover:from-blue-400 hover:to-indigo-500 active:scale-[0.98]">Confirm Swap</button>
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
      <span className={`text-xs font-medium text-right ${highlight ? 'text-white' : 'text-white/70'}`}>{value}</span>
    </div>
  )
}

function CopyHashButton({ hash, label = 'Copy transaction hash' }: { hash: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  function copyHash() {
    navigator.clipboard.writeText(hash).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }).catch(() => {})
  }

  return (
    <button type="button" onClick={copyHash} aria-label={label} className="shrink-0 rounded-md p-1 text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/60">
      {copied
        ? <svg className="h-3.5 w-3.5 text-emerald-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
        : <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" /><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" /></svg>}
    </button>
  )
}

function QuotePreview({
  tokenIn,
  tokenOut,
  amountIn,
  estimatedOut,
}: {
  tokenIn: SupportedToken
  tokenOut: SupportedToken
  amountIn: string
  estimatedOut: string | null
}) {
  const rate = computeRate(amountIn, estimatedOut)

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.025] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-white/35">Quote preview</p>
        <span className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[10px] font-medium text-white/40">{ARC_TESTNET_NAME}</span>
      </div>
      <div className="space-y-2 text-xs">
        <ModalRow label="Pair" value={`${tokenIn} -> ${tokenOut}`} highlight />
        <ModalRow label="Input" value={isValidAmount(amountIn) ? `${amountIn} ${tokenIn}` : `0 ${tokenIn}`} />
        <ModalRow label="Estimated output" value={estimatedOut ? `${estimatedOut} ${tokenOut}` : 'Final quote will be verified during swap preparation.'} />
        <ModalRow label="Exchange rate" value={rate ? `1 ${tokenIn} = ${rate} ${tokenOut}` : 'Final quote will be verified during swap preparation.'} />
        <ModalRow label="Expected network" value={ARC_TESTNET_NAME} />
      </div>
    </div>
  )
}

function StatusTimeline({ phase, approveTxHash }: { phase: Phase; approveTxHash: string | null }) {
  const approvalLabel = approveTxHash
    ? 'Approval required'
    : phase === 'approval-skipped' || phase === 'waiting-swap' || phase === 'verifying' || phase === 'success' || phase === 'confirmed-no-delta'
      ? 'Approval skipped'
      : 'Approval required / Approval skipped'

  const steps = [
    { key: 'preparing', label: 'Preparing', done: phase !== 'idle' && phase !== 'preparing', active: phase === 'preparing' || phase === 'checking-allowance' },
    { key: 'approval-mode', label: approvalLabel, done: phase === 'approval-skipped' || phase === 'waiting-approval' || phase === 'approval-confirmed' || phase === 'waiting-swap' || phase === 'verifying' || phase === 'success' || phase === 'confirmed-no-delta', active: phase === 'checking-allowance' },
    { key: 'waiting-approval', label: 'Waiting for approval', done: phase === 'approval-confirmed' || phase === 'waiting-swap' || phase === 'verifying' || phase === 'success' || phase === 'confirmed-no-delta', active: phase === 'waiting-approval', hidden: approvalLabel === 'Approval skipped' },
    { key: 'approval-confirmed', label: 'Approval confirmed', done: phase === 'waiting-swap' || phase === 'verifying' || phase === 'success' || phase === 'confirmed-no-delta', active: phase === 'approval-confirmed', hidden: approvalLabel === 'Approval skipped' },
    { key: 'waiting-swap', label: 'Submitting swap', done: phase === 'verifying' || phase === 'success' || phase === 'confirmed-no-delta', active: phase === 'waiting-swap' },
    { key: 'swap-confirmed', label: 'Swap confirmed', done: phase === 'verifying' || phase === 'success' || phase === 'confirmed-no-delta', active: false },
    { key: 'verifying', label: 'Verifying transfer events', done: phase === 'success' || phase === 'confirmed-no-delta', active: phase === 'verifying' },
    { key: 'final', label: phase === 'confirmed-no-delta' ? 'Verification failed' : 'Success', done: phase === 'success' || phase === 'confirmed-no-delta', active: false, failed: phase === 'confirmed-no-delta' },
  ].filter((step) => !step.hidden)

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="mb-3 flex items-center gap-2">
        {phase !== 'success' && phase !== 'confirmed-no-delta' && <Spinner />}
        <p className="text-xs font-semibold uppercase tracking-wider text-white/35">Transaction status</p>
      </div>
      <div className="space-y-2">
        {steps.map((step) => (
          <div key={step.key} className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 rounded-full ${
              step.failed
                ? 'bg-amber-400'
                : step.done
                  ? 'bg-emerald-400'
                  : step.active
                    ? 'bg-blue-400'
                    : 'bg-white/15'
            }`} />
            <span className={`text-xs ${
              step.failed
                ? 'text-amber-300'
                : step.done
                  ? 'text-white/65'
                  : step.active
                    ? 'text-blue-300'
                    : 'text-white/30'
            }`}>{step.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Result Card ──────────────────────────────────────────────────────────────
// Handles both 'success' and 'confirmed-no-delta' states.

interface ResultCardProps {
  phase: Phase
  tokenIn: SupportedToken
  tokenOut: SupportedToken
  amountIn: string
  estimatedOut: string | null
  approveTxHash: string | null
  swapTxHash: string
  verification: VerificationResult | null
  onVerify: () => void
  onNewSwap: () => void
  verifying: boolean
}

function ResultCard({
  phase, tokenIn, tokenOut, amountIn, estimatedOut,
  approveTxHash, swapTxHash, verification, onVerify, onNewSwap, verifying,
}: ResultCardProps) {
  const isSuccess = phase === 'success'

  return (
    <div className={`mt-4 rounded-2xl border p-4 space-y-3 ${
      isSuccess
        ? 'border-emerald-500/30 bg-emerald-500/[0.07]'
        : 'border-amber-500/30 bg-amber-500/[0.07]'
    }`}>
      {/* Status header */}
      <div className="flex items-center gap-2">
        {isSuccess ? (
          <svg className="h-4 w-4 text-emerald-400 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg className="h-4 w-4 text-amber-400 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        )}
        <p className={`text-sm font-semibold ${isSuccess ? 'text-emerald-400' : 'text-amber-400'}`}>
          {isSuccess ? 'Swap successful!' : 'Transaction confirmed, balance change not detected'}
        </p>
      </div>

      {!isSuccess && (
        <p className="text-xs text-amber-300/70 leading-relaxed">
          The transaction was mined successfully, but the expected token balance changes were not detected.
          Check the explorer transaction and token transfer logs.
        </p>
      )}

      <div className="space-y-2 text-xs">
        {/* Amounts */}
        <div className="flex items-center justify-between">
          <span className="text-white/40">Swapped</span>
          <span className="text-white/70 font-medium">{amountIn} {tokenIn} &rarr; {tokenOut}</span>
        </div>

        {/* Actual delta from verification */}
        {verification && verification.deltaOut > BigInt(0) && (
          <div className="flex items-center justify-between">
            <span className="text-white/40">Received</span>
            <span className="text-white/70 font-medium">{verification.deltaOutFormatted} {tokenOut}</span>
          </div>
        )}
        {verification && verification.deltaOut === BigInt(0) && estimatedOut && (
          <div className="flex items-center justify-between">
            <span className="text-white/40">Est. received</span>
            <span className="text-white/50 font-medium">{estimatedOut} {tokenOut}</span>
          </div>
        )}
        {!verification && estimatedOut && (
          <div className="flex items-center justify-between">
            <span className="text-white/40">Est. received</span>
            <span className="text-white/70 font-medium">{estimatedOut} {tokenOut}</span>
          </div>
        )}

        {/* Transfer events */}
        {verification?.transfersDetected && (
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 space-y-1">
            <p className="text-[10px] font-semibold text-white/30 uppercase tracking-wider">Transfer events</p>
            {verification.transferInAmount && (
              <div className="flex items-center justify-between">
                <span className="text-white/30">Sent</span>
                <span className="text-white/50">{verification.transferInAmount} {tokenIn}</span>
              </div>
            )}
            {verification.transferOutAmount && (
              <div className="flex items-center justify-between">
                <span className="text-white/30">Received</span>
                <span className="text-white/50">{verification.transferOutAmount} {tokenOut}</span>
              </div>
            )}
          </div>
        )}

        {/* Post-swap balances */}
        {verification && (
          <div className="border-t border-white/[0.06] pt-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-white/30">New {tokenIn} balance</span>
              <span className="text-white/50 font-medium">{verification.balanceInFormatted} {tokenIn}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-white/30">New {tokenOut} balance</span>
              <span className="text-white/50 font-medium">{verification.balanceOutFormatted} {tokenOut}</span>
            </div>
          </div>
        )}

        {/* Tx links */}
        {approveTxHash && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-white/40 shrink-0">Approval</span>
            <a href={`${ARC_TESTNET_EXPLORER}/tx/${approveTxHash}`} target="_blank" rel="noopener noreferrer" className="text-white/40 underline underline-offset-2 hover:text-white/60 truncate max-w-[160px]">
              {truncateHash(approveTxHash)}
            </a>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-white/40 shrink-0">Swap Tx</span>
          <div className="flex items-center gap-1.5 min-w-0">
            <a href={`${ARC_TESTNET_EXPLORER}/tx/${swapTxHash}`} target="_blank" rel="noopener noreferrer" className={`underline underline-offset-2 truncate max-w-[130px] ${isSuccess ? 'text-emerald-400 hover:text-emerald-300' : 'text-amber-400 hover:text-amber-300'}`}>
              {truncateHash(swapTxHash)}
            </a>
            <CopyHashButton hash={swapTxHash} label="Copy swap transaction hash" />
          </div>
        </div>

        {/* Verify button */}
        <button
          type="button"
          onClick={onVerify}
          disabled={verifying}
          className="mt-1 flex items-center gap-1.5 text-xs text-white/25 transition-colors hover:text-white/50 disabled:opacity-30"
        >
          <svg className={`h-3 w-3 ${verifying ? 'animate-spin' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
          </svg>
          {verifying ? 'Verifying\u2026' : 'Verify transaction'}
        </button>

        {isSuccess && (
          <button
            type="button"
            onClick={onNewSwap}
            className="mt-2 w-full rounded-xl border border-emerald-500/25 bg-emerald-500/10 py-2.5 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/15"
          >
            New swap
          </button>
        )}
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
        <button type="button" onClick={onClear} className="text-xs text-white/20 transition-colors hover:text-white/50">Clear</button>
      </div>
      <div className="space-y-2">
        {history.slice(0, 10).map((entry) => {
          const status = entry.status ?? 'success'
          const statusClass = status === 'success'
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
            : status === 'verification-failed'
              ? 'border-amber-500/25 bg-amber-500/10 text-amber-300'
              : 'border-red-500/25 bg-red-500/10 text-red-300'
          const statusLabel = status === 'verification-failed'
            ? 'Verification failed'
            : status === 'failed'
              ? 'Failed'
              : 'Success'

          return (
            <div key={entry.id} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass}`}>{statusLabel}</span>
                <span className="text-[10px] text-white/25">
                  {new Date(entry.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-white/35">Pair</span>
                  <span className="font-semibold text-white/70">{entry.tokenIn} &rarr; {entry.tokenOut}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-white/35">Sent</span>
                  <span className="text-white/55">{entry.amountIn} {entry.tokenIn}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-white/35">Received</span>
                  <span className="text-white/55">{entry.estimatedOut ? `${entry.estimatedOut} ${entry.tokenOut}` : 'Unavailable'}</span>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {entry.approveTxHash && (
                  <a href={`${ARC_TESTNET_EXPLORER}/tx/${entry.approveTxHash}`} target="_blank" rel="noopener noreferrer" className="text-[11px] text-white/30 underline underline-offset-2 hover:text-white/50">Approval tx</a>
                )}
                {entry.swapTxHash && (
                  <span className="flex min-w-0 items-center gap-1">
                    <a href={`${ARC_TESTNET_EXPLORER}/tx/${entry.swapTxHash}`} target="_blank" rel="noopener noreferrer" className="max-w-[140px] truncate text-[11px] text-emerald-500/70 underline underline-offset-2 hover:text-emerald-400">Swap tx {truncateHash(entry.swapTxHash, 6)}</a>
                    <CopyHashButton hash={entry.swapTxHash} label="Copy recent swap transaction hash" />
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
//  Main component ─

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
  const [verification, setVerification] = useState<VerificationResult | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [ignoredTransferReasons, setIgnoredTransferReasons] = useState<string[]>([])

  const [balanceIn, setBalanceIn] = useState<string | null>(null)
  const [balanceOut, setBalanceOut] = useState<string | null>(null)
  const [rawBalanceIn, setRawBalanceIn] = useState<bigint | null>(null)
  const [rawBalanceOut, setRawBalanceOut] = useState<bigint | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [balanceStale, setBalanceStale] = useState(false)
  const [pairUnavailable, setPairUnavailable] = useState(false)

  const isSwappingRef = useRef(false)
  const phaseRef = useRef<Phase>('idle')
  // Stores the last swap tx hash for the "Verify transaction" button
  const lastSwapTxRef = useRef<string | null>(null)
  // Stores pre-swap balance snapshot
  const snapshotRef = useRef<BalanceSnapshot | null>(null)

  const isActive =
    phase === 'preparing' ||
    phase === 'checking-allowance' ||
    phase === 'approval-skipped' ||
    phase === 'waiting-approval' ||
    phase === 'approval-confirmed' ||
    phase === 'waiting-swap' ||
    phase === 'verifying'

  //  Read raw bigint balance for a single token 

  async function readRawBalance(token: SupportedToken): Promise<bigint> {
    if (!address || !publicClient) return BigInt(0)
    try {
      const result = await publicClient.readContract({
        address: TOKEN_ADDRESSES[token],
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      })
      return result as bigint
    } catch {
      return BigInt(0)
    }
  }

  //  Balance fetch (display) 

  const fetchBalances = useCallback(async (inToken: SupportedToken, outToken: SupportedToken) => {
    if (!address || !publicClient || chainId !== ARC_TESTNET_CHAIN_ID) {
      startTransition(() => {
        setBalanceIn(null)
        setBalanceOut(null)
        setRawBalanceIn(null)
        setRawBalanceOut(null)
      })
      return
    }
    startTransition(() => setBalanceLoading(true))
    try {
      const [rawIn, rawOut] = await Promise.allSettled([
        publicClient.readContract({ address: TOKEN_ADDRESSES[inToken], abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
        publicClient.readContract({ address: TOKEN_ADDRESSES[outToken], abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
      ])
      startTransition(() => {
        const nextRawIn = rawIn.status === 'fulfilled' ? rawIn.value as bigint : null
        const nextRawOut = rawOut.status === 'fulfilled' ? rawOut.value as bigint : null
        setRawBalanceIn(nextRawIn)
        setRawBalanceOut(nextRawOut)
        setBalanceIn(nextRawIn !== null ? formatBalance(nextRawIn, TOKEN_DECIMALS[inToken]) : null)
        setBalanceOut(nextRawOut !== null ? formatBalance(nextRawOut, TOKEN_DECIMALS[outToken]) : null)
      })
    } catch {
      startTransition(() => {
        setBalanceIn(null)
        setBalanceOut(null)
        setRawBalanceIn(null)
        setRawBalanceOut(null)
      })
    } finally {
      startTransition(() => setBalanceLoading(false))
    }
  }, [address, publicClient, chainId])

  useEffect(() => {
    let cancelled = false
    fetchBalances(tokenIn, tokenOut).then(() => { if (cancelled) return }).catch(() => {})
    return () => { cancelled = true }
  }, [fetchBalances, tokenIn, tokenOut])

  //  Decode Transfer events from receipt logs 

  function decodeTransfers(
    logs: readonly { address: string; topics: readonly string[]; data: string }[],
    walletAddr: string,
    inToken: SupportedToken,
    outToken: SupportedToken,
    amountInBaseUnits: bigint,
  ): {
    transferInAmount: string | null
    transferOutAmount: string | null
    transfersDetected: boolean
    transferInRaw: bigint
    transferOutRaw: bigint
    ignoredReasons: string[]
  } {
    // A Transfer only counts as the swap transfer if its amount is >= 10% of
    // amountIn. Protocol/service fees are typically < 1%, so this threshold
    // cleanly separates real swap transfers from fee transfers.
    const MIN_FRACTION = BigInt(10) // 10%
    const minSwapAmount = (amountInBaseUnits * MIN_FRACTION) / BigInt(100)

    let bestTransferIn = BigInt(0)
    let bestTransferOut = BigInt(0)
    const ignoredReasons: string[] = []
    const wallet = walletAddr.toLowerCase()

    for (const log of logs) {
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({
          abi: ERC20_ABI,
          eventName: 'Transfer',
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          data: log.data as `0x${string}`,
        })
        const from = (decoded.args as { from: string; to: string; value: bigint }).from.toLowerCase()
        const to = (decoded.args as { from: string; to: string; value: bigint }).to.toLowerCase()
        const value = (decoded.args as { from: string; to: string; value: bigint }).value

        const logAddr = log.address.toLowerCase()
        const inAddr = TOKEN_ADDRESSES[inToken].toLowerCase()
        const outAddr = TOKEN_ADDRESSES[outToken].toLowerCase()

        // tokenIn leaving wallet
        if (logAddr === inAddr && from === wallet) {
          if (value >= minSwapAmount) {
            if (value > bestTransferIn) bestTransferIn = value
          } else {
            // Too small — this is a fee transfer, not the swap transfer
            ignoredReasons.push(
              `Ignored tokenIn transfer of ${formatDelta(value, TOKEN_DECIMALS[inToken])} ${inToken} ` +
              `(below 10% threshold of ${formatDelta(minSwapAmount, TOKEN_DECIMALS[inToken])} ${inToken})`
            )
          }
        }

        // tokenOut entering wallet — any positive amount counts
        if (logAddr === outAddr && to === wallet && value > BigInt(0)) {
          if (value > bestTransferOut) bestTransferOut = value
        }
      } catch {
        // log not decodable as Transfer — skip
      }
    }

    // Both tokenIn AND tokenOut must be detected for a real swap
    const transfersDetected = bestTransferIn > BigInt(0) && bestTransferOut > BigInt(0)

    return {
      transferInAmount: bestTransferIn > BigInt(0)
        ? formatDelta(bestTransferIn, TOKEN_DECIMALS[inToken])
        : null,
      transferOutAmount: bestTransferOut > BigInt(0)
        ? formatDelta(bestTransferOut, TOKEN_DECIMALS[outToken])
        : null,
      transfersDetected,
      transferInRaw: bestTransferIn,
      transferOutRaw: bestTransferOut,
      ignoredReasons,
    }
  }

  //  Verify swap result 

  async function verifySwap(
    txHash: string,
    snapshot: BalanceSnapshot,
    inToken: SupportedToken,
    outToken: SupportedToken,
    amountInStr: string,
  ): Promise<{ result: VerificationResult; passed: boolean; ignoredReasons: string[] }> {
    if (!publicClient || !address) throw new Error('No public client')

    // Convert amountIn to base units for threshold calculations
    const decimals = TOKEN_DECIMALS[inToken]
    const amountInBaseUnits = BigInt(Math.round(parseFloat(amountInStr) * Math.pow(10, decimals)))

    // Re-read receipt for log decoding
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` })

    // Decode Transfer events with strict amount filtering
    const transfers = decodeTransfers(
      receipt.logs as { address: string; topics: readonly string[]; data: string }[],
      address,
      inToken,
      outToken,
      amountInBaseUnits,
    )

    // Read post-swap balances
    const [rawInAfter, rawOutAfter] = await Promise.all([
      readRawBalance(inToken),
      readRawBalance(outToken),
    ])

    const deltaIn = snapshot.rawIn - rawInAfter    // positive = spent
    const deltaOut = rawOutAfter - snapshot.rawOut  // positive = received

    // Strict balance-delta check:
    // deltaIn must be >= 10% of amountIn to exclude gas-only USDC loss.
    // Arc uses USDC as native gas — gas fees alone can cause small deltaIn.
    // deltaOut must be > 0.
    const minDeltaIn = (amountInBaseUnits * BigInt(10)) / BigInt(100)
    const balanceDeltaPassed = deltaIn >= minDeltaIn && deltaOut > BigInt(0)

    // Transfer-log check: both tokenIn outgoing AND tokenOut incoming must be
    // detected at meaningful amounts (already filtered in decodeTransfers).
    const transfersPassed = transfers.transfersDetected

    const result: VerificationResult = {
      deltaIn,
      deltaOut,
      deltaInFormatted: formatDelta(deltaIn < BigInt(0) ? -deltaIn : deltaIn, TOKEN_DECIMALS[inToken]),
      deltaOutFormatted: formatDelta(deltaOut < BigInt(0) ? -deltaOut : deltaOut, TOKEN_DECIMALS[outToken]),
      balanceInAfter: rawInAfter,
      balanceOutAfter: rawOutAfter,
      balanceInFormatted: formatBalance(rawInAfter, TOKEN_DECIMALS[inToken]),
      balanceOutFormatted: formatBalance(rawOutAfter, TOKEN_DECIMALS[outToken]),
      transfersDetected: transfers.transfersDetected,
      transferInAmount: transfers.transferInAmount,
      transferOutAmount: transfers.transferOutAmount,
    }

    // Pass only if BOTH tokenIn was spent AND tokenOut was received at meaningful amounts.
    // A fee-only transaction has no tokenOut transfer and tiny tokenIn movement — both fail.
    const passed = balanceDeltaPassed || transfersPassed

    return { result, passed, ignoredReasons: transfers.ignoredReasons }
  }

  //  Manual verify button 

  async function handleVerify() {
    const txHash = lastSwapTxRef.current
    const snapshot = snapshotRef.current
    if (!txHash || !snapshot || verifying) return
    setVerifying(true)
    try {
      const { result, passed, ignoredReasons } = await verifySwap(txHash, snapshot, tokenIn, tokenOut, amountIn)
      setVerification(result)
      setIgnoredTransferReasons(ignoredReasons)
      // Update displayed balances
      startTransition(() => {
        setBalanceIn(result.balanceInFormatted)
        setBalanceOut(result.balanceOutFormatted)
      })
      setPhaseSync(passed ? 'success' : 'confirmed-no-delta')
    } catch {
      // Verification failed  leave phase as-is
    } finally {
      setVerifying(false)
    }
  }

  //  Max button 

  function handleMax() {
    if (!balanceIn) return
    const n = parseFloat(balanceIn.replace(/,/g, ''))
    if (!isFinite(n) || n <= 0) return
    const safe = tokenIn === 'USDC' ? Math.max(0, n - GAS_BUFFER_USDC) : n
    if (safe <= 0) return
    setAmountIn(safe.toFixed(TOKEN_DECIMALS[tokenIn] > 6 ? 8 : 6))
    resetForm()
  }

  //  Validation 

  function getValidationError(): string | null {
    if (!isConnected) return 'Wallet not connected.'
    if (chainId !== ARC_TESTNET_CHAIN_ID) return 'Please switch to Arc Testnet.'
    if (!walletClient) return 'Wallet client unavailable. Try reconnecting.'
    if (tokenIn === tokenOut) return 'Select different tokens.'
    if (!isValidAmount(amountIn)) return 'Enter a valid amount greater than zero.'
    if (pairUnavailable) return 'This pair is temporarily unavailable on Arc Testnet.'
    const amountBaseUnits = parseAmountToBaseUnits(amountIn, TOKEN_DECIMALS[tokenIn])
    if (rawBalanceIn !== null && amountBaseUnits !== null && amountBaseUnits > rawBalanceIn) {
      return 'Insufficient balance.'
    }
    return null
  }

  const validationError = getValidationError()
  const canOpenModal = validationError === null && !isActive

  //  Reset 

  function setPhaseSync(p: Phase) {
    phaseRef.current = p
    setPhase(p)
  }

  function resetForm() {
    setError(null)
    setApproveTxHash(null)
    setSwapTxHash(null)
    setEstimatedOut(null)
    setVerification(null)
    setIgnoredTransferReasons([])
    setBalanceStale(false)
    setPairUnavailable(false)
    setPhaseSync('idle')
  }

  function clearSwapResult() {
    setError(null)
    setApproveTxHash(null)
    setSwapTxHash(null)
    setEstimatedOut(null)
    setVerification(null)
    setIgnoredTransferReasons([])
    setBalanceStale(false)
    setPhaseSync('idle')
    lastSwapTxRef.current = null
    snapshotRef.current = null
  }

  function handleReversePair() {
    if (isActive) return
    const nextTokenIn = tokenOut
    const nextTokenOut = tokenIn
    const amountBaseUnits = parseAmountToBaseUnits(amountIn, TOKEN_DECIMALS[nextTokenIn])
    const canKeepAmount = amountIn === '' || rawBalanceOut === null || (amountBaseUnits !== null && amountBaseUnits <= rawBalanceOut)

    setTokenIn(nextTokenIn)
    setTokenOut(nextTokenOut)
    setAmountIn(canKeepAmount ? amountIn : '')
    clearSwapResult()
    fetchBalances(nextTokenIn, nextTokenOut).catch(() => {})
  }

  function handleNewSwap() {
    setAmountIn('')
    clearSwapResult()
    fetchBalances(tokenIn, tokenOut).catch(() => {})
  }

  function handleSwapButtonClick() {
    if (!canOpenModal) return
    setShowModal(true)
  }

  function handleModalCancel() {
    setShowModal(false)
  }

  //  Confirmed swap 

  async function handleConfirmedSwap() {
    if (isSwappingRef.current) return
    if (!canOpenModal || !walletClient || !address || !publicClient) return

    isSwappingRef.current = true
    setShowModal(false)
    resetForm()
    setPhaseSync('preparing')
    let finalApproveTxHash: string | null = null
    let finalSwapTxHash: string | null = null

    try {
      // Step 1: Snapshot pre-swap balances (raw bigint)
      const [rawInBefore, rawOutBefore] = await Promise.all([
        readRawBalance(tokenIn),
        readRawBalance(tokenOut),
      ])
      const snapshot: BalanceSnapshot = { rawIn: rawInBefore, rawOut: rawOutBefore }
      snapshotRef.current = snapshot

      // Step 2: Get EVM payload from server proxy
      const res = await fetch('/api/circle/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenIn, tokenOut, amountIn, fromAddress: address, toAddress: address, chain: 'Arc_Testnet' }),
      })

      const data: ProxyResponse = await res.json()

      if (!res.ok || !data.ok) {
        const msg = data.error ?? `Server error ${res.status}`
        throw new Error(isUnsupportedPairError(msg) ? 'This token pair is not currently supported on Arc Testnet.' : msg)
      }

      setEstimatedOut(data.estimatedAmountFormatted ?? null)

      const tx = data.transaction as SwapTransaction
      if (!tx?.executionParams?.instructions?.length) {
        throw new Error('Circle returned an empty transaction payload.')
      }

      const tokenInAddress = data.tokenInAddress
      const inputAmount = BigInt(data.amount ?? data.amountBaseUnits)
      const isNativeInput = tokenInAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase()

      // Step 3: ERC-20 approval for the Adapter Contract.
      // Use Circle's top-level amount as the wallet approval amount. Nested
      // instruction.amountToApprove values are for adapter-to-router approvals.
      const requiredAmount = isNativeInput ? BigInt(0) : inputAmount
      let approvalWasSkipped = true

      if (!isNativeInput && tokenInAddress && requiredAmount > BigInt(0)) {
        setPhaseSync('checking-allowance')
        let currentAllowance = BigInt(0)
        try {
          const result = await publicClient.readContract({
            address: tokenInAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [address, ADAPTER_CONTRACT],
          })
          currentAllowance = result as bigint
        } catch {
          currentAllowance = BigInt(0)
        }

        if (currentAllowance < requiredAmount) {
          approvalWasSkipped = false
          setPhaseSync('waiting-approval')
          const approveData = encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [ADAPTER_CONTRACT, requiredAmount],
          })
          const approveTx = await walletClient.sendTransaction({
            to: tokenInAddress as `0x${string}`,
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

      if (approvalWasSkipped) {
        setPhaseSync('approval-skipped')
      }

      // Step 4: Build and execute the Adapter Contract execute() call.
      //
      // The Circle Swap Kit routes swaps through the Adapter Contract:
      //   AdapterContract.execute(executeParams, tokenInputs, signature)
      //
      // executeParams: the full struct from Circle's response
      // tokenInputs:   tells the adapter which token to pull and how much
      //                (PermitType.NONE = pre-approved via ERC-20 approve above)
      // signature:     Circle's server-signed authorization
      // value:         native input value when Circle's payload requires it
      setPhaseSync('waiting-swap')

      // Build executeParams struct from Circle's response
      const executeParams = {
        instructions: tx.executionParams.instructions.map((instr) => ({
          target:          instr.target as `0x${string}`,
          data:            instr.data as `0x${string}`,
          value:           BigInt(instr.value || '0'),
          tokenIn:         instr.tokenIn as `0x${string}`,
          amountToApprove: BigInt(instr.amountToApprove || '0'),
          tokenOut:        instr.tokenOut as `0x${string}`,
          minTokenOut:     BigInt(instr.minTokenOut || '0'),
        })),
        tokens: tx.executionParams.tokens.map((t) => ({
          token:       t.token as `0x${string}`,
          beneficiary: t.beneficiary as `0x${string}`,
        })),
        execId:   BigInt(tx.executionParams.execId),
        deadline: BigInt(tx.executionParams.deadline),
        metadata: tx.executionParams.metadata as `0x${string}`,
      }

      const totalInstructionValue = executeParams.instructions.reduce(
        (sum, instr) => sum + instr.value,
        BigInt(0),
      )
      const txValue = totalInstructionValue > BigInt(0)
        ? totalInstructionValue
        : isNativeInput
          ? inputAmount
          : BigInt(0)

      // tokenInputs: PermitType.NONE (0) = use pre-approved ERC-20 allowance.
      // Native inputs are sent as msg.value, so they do not have a token input.
      const tokenInputs = !isNativeInput && tokenInAddress
        ? [
            {
              permitType:     0,
              token:          tokenInAddress as `0x${string}`,
              amount:         inputAmount,
              permitCalldata: '0x' as `0x${string}`,
            },
          ]
        : []

      const signature = (tx.signature ?? '0x') as `0x${string}`

      if (process.env.NODE_ENV === 'development') {
        console.log('[swap] Adapter execute() call:', {
          to: ADAPTER_CONTRACT,
          value: txValue.toString(),
          tokenIn,
          tokenOut,
          amountIn,
          circleAmount: data.amount,
          amountBaseUnits: data.amountBaseUnits,
          tokenInAddress,
          requiredAmount: requiredAmount.toString(),
          tokenInputsCount: tokenInputs.length,
          gasLimit: tx.gasLimit,
          execId: tx.executionParams.execId,
          deadline: tx.executionParams.deadline,
          instructionCount: tx.executionParams.instructions.length,
          signature: signature.slice(0, 20) + '…',
        })
      }

      const adapterCalldata = encodeFunctionData({
        abi: ADAPTER_ABI,
        functionName: 'execute',
        args: [executeParams, tokenInputs, signature],
      })

      const finalTxHash = await walletClient.sendTransaction({
        to: ADAPTER_CONTRACT,
        data: adapterCalldata,
        value: txValue,
        gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
        account: address,
        chain: walletClient.chain,
      })

      finalSwapTxHash = finalTxHash
      setSwapTxHash(finalTxHash)
      lastSwapTxRef.current = finalTxHash
      await publicClient.waitForTransactionReceipt({ hash: finalTxHash })

      // Step 5: Verify  wait for RPC indexing then check balance deltas + Transfer events
      setPhaseSync('verifying')
      await new Promise((resolve) => setTimeout(resolve, 1500))

      const { result, passed, ignoredReasons } = await verifySwap(finalTxHash, snapshot, tokenIn, tokenOut, amountIn)
      setVerification(result)
      setIgnoredTransferReasons(ignoredReasons)

      // Update displayed balances from verification
      startTransition(() => {
        setBalanceIn(result.balanceInFormatted)
        setBalanceOut(result.balanceOutFormatted)
      })

      setPhaseSync(passed ? 'success' : 'confirmed-no-delta')

      // Step 6: Record in history only if verification passed
      if (passed) {
        addEntry({
          timestamp: Date.now(),
          chainId: ARC_TESTNET_CHAIN_ID,
          status: 'success',
          tokenIn, tokenOut, amountIn,
          estimatedOut: result.deltaOut > BigInt(0)
            ? result.deltaOutFormatted
            : (data.estimatedAmountFormatted ?? null),
          approveTxHash: finalApproveTxHash,
          swapTxHash: finalTxHash,
        })
      } else {
        addEntry({
          timestamp: Date.now(),
          chainId: ARC_TESTNET_CHAIN_ID,
          status: 'verification-failed',
          tokenIn, tokenOut, amountIn,
          estimatedOut: result.deltaOut > BigInt(0)
            ? result.deltaOutFormatted
            : (data.estimatedAmountFormatted ?? null),
          approveTxHash: finalApproveTxHash,
          swapTxHash: finalTxHash,
          errorMessage: 'Verification failed',
        })
      }

      setBalanceStale(false)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.'
      if (isUserRejection(message)) {
        const p = phaseRef.current
        const wasApproving = p === 'waiting-approval' || p === 'checking-allowance'
        setError(wasApproving ? 'User rejected approval.' : 'User rejected swap.')
      } else {
        const friendlyMessage = formatErrorMessage(message, phaseRef.current)
        setError(friendlyMessage)
        if (friendlyMessage === 'This pair is temporarily unavailable on Arc Testnet.') {
          setPairUnavailable(true)
        }
        if (finalSwapTxHash) {
          addEntry({
            timestamp: Date.now(),
            chainId: ARC_TESTNET_CHAIN_ID,
            status: 'failed',
            tokenIn, tokenOut, amountIn,
            estimatedOut,
            approveTxHash: finalApproveTxHash,
            swapTxHash: finalSwapTxHash,
            errorMessage: friendlyMessage,
          })
        }
      }
      setPhaseSync('error')
    } finally {
      isSwappingRef.current = false
    }
  }

  const isDev = process.env.NODE_ENV === 'development'
  const showResult = phase === 'success' || phase === 'confirmed-no-delta'

  return (
    <>
      {showModal && address && (
        <ReviewModal tokenIn={tokenIn} tokenOut={tokenOut} amountIn={amountIn} address={address} onConfirm={handleConfirmedSwap} onCancel={handleModalCancel} />
      )}

      <div className="flex flex-col items-center w-full max-w-md">
        <div className="w-full relative overflow-hidden rounded-3xl border border-white/[0.08] bg-[#111318] shadow-2xl shadow-black/60">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.5) 40%, rgba(99,102,241,0.5) 60%, transparent)' }} aria-hidden="true" />

          <div className="p-5">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Swap</h2>
              <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-400">Arc Testnet</span>
            </div>

            {!isConnected && (
              <div className="mb-4 flex flex-col items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                <p className="text-sm text-white/50">Connect your wallet to swap</p>
                <ConnectButton />
              </div>
            )}

            {isConnected && chainId !== ARC_TESTNET_CHAIN_ID && (
              <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <p className="mb-2 text-xs text-amber-400">Switch to Arc Testnet to continue.</p>
                <button type="button" onClick={() => switchChain({ chainId: ARC_TESTNET_CHAIN_ID })} disabled={isSwitching} className="flex items-center gap-2 rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-300 transition-colors hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-50">
                  {isSwitching && <Spinner />}
                  Switch to Arc Testnet
                </button>
              </div>
            )}

            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2 sm:gap-3">
                <TokenSelect label="From" value={tokenIn} onChange={(v) => { setTokenIn(v); resetForm() }} exclude={tokenOut} disabled={isActive} balance={isConnected && chainId === ARC_TESTNET_CHAIN_ID ? balanceIn : undefined} balanceLoading={balanceLoading} onMax={isConnected && chainId === ARC_TESTNET_CHAIN_ID ? handleMax : undefined} />
                <button
                  type="button"
                  onClick={handleReversePair}
                  disabled={isActive}
                  aria-label="Reverse token pair"
                  className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.05] text-white/45 transition-colors hover:border-white/[0.14] hover:text-white/80 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M13.293 3.293a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L14.586 8H4a1 1 0 010-2h10.586l-1.293-1.293a1 1 0 010-1.414zM6.707 16.707a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 1.414L5.414 12H16a1 1 0 110 2H5.414l1.293 1.293a1 1 0 010 1.414z" clipRule="evenodd" />
                  </svg>
                </button>
                <TokenSelect label="To" value={tokenOut} onChange={(v) => { setTokenOut(v); resetForm() }} exclude={tokenIn} disabled={isActive} balance={isConnected && chainId === ARC_TESTNET_CHAIN_ID ? balanceOut : undefined} balanceLoading={balanceLoading} />
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="circle-amount-in" className="text-xs font-medium uppercase tracking-wider text-white/40">Amount</label>
                <input id="circle-amount-in" type="number" inputMode="decimal" placeholder="0.00" value={amountIn} onChange={(e) => { setAmountIn(e.target.value); resetForm() }} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }} disabled={isActive} min="0" step="any" aria-label={`Amount of ${tokenIn} to swap`} className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-xl font-semibold text-white outline-none placeholder:text-white/20 transition-colors hover:border-white/[0.14] focus:border-blue-500/50 focus:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
              </div>

              <QuotePreview tokenIn={tokenIn} tokenOut={tokenOut} amountIn={amountIn} estimatedOut={estimatedOut} />

              {(isActive || showResult) && <StatusTimeline phase={phase} approveTxHash={approveTxHash} />}

              {!isActive && isConnected && chainId === ARC_TESTNET_CHAIN_ID && (
                <div className="flex items-center justify-between">
                  {balanceStale && <p className="text-xs text-white/30">Swap confirmed. Balance may take a few seconds to update.</p>}
                  <button type="button" onClick={() => fetchBalances(tokenIn, tokenOut)} disabled={balanceLoading} className="ml-auto flex items-center gap-1.5 text-xs text-white/25 transition-colors hover:text-white/50 disabled:opacity-30" aria-label="Refresh balances">
                    <svg className={`h-3 w-3 ${balanceLoading ? 'animate-spin' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" /></svg>
                    Refresh
                  </button>
                </div>
              )}

              <button type="button" onClick={handleSwapButtonClick} disabled={!canOpenModal} aria-label={`Swap ${tokenIn} for ${tokenOut}`} className={`w-full rounded-2xl py-4 text-base font-semibold tracking-wide transition-all duration-200 ${canOpenModal ? 'bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-500/25 hover:from-blue-400 hover:to-indigo-500 hover:shadow-blue-500/40 active:scale-[0.98]' : 'cursor-not-allowed bg-white/[0.06] text-white/25'}`}>
                {isActive ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner />
                    {phase === 'preparing' || phase === 'checking-allowance' || phase === 'approval-skipped' ? 'Preparing\u2026' : phase === 'waiting-approval' ? 'Approve in wallet\u2026' : phase === 'approval-confirmed' ? 'Approved\u2026' : phase === 'verifying' ? 'Verifying\u2026' : 'Confirm in wallet\u2026'}
                  </span>
                ) : `Swap ${tokenIn} \u2192 ${tokenOut}`}
              </button>

              {validationError && !error && isConnected && chainId === ARC_TESTNET_CHAIN_ID && (
                <p className="text-center text-xs text-white/30">{validationError}</p>
              )}
            </div>

            {phase === 'error' && error && (
              <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
                <p className="text-xs font-semibold text-red-400">{error}</p>
              </div>
            )}

            {showResult && swapTxHash && (
              <ResultCard
                phase={phase}
                tokenIn={tokenIn}
                tokenOut={tokenOut}
                amountIn={amountIn}
                estimatedOut={estimatedOut}
                approveTxHash={approveTxHash}
                swapTxHash={swapTxHash}
                verification={verification}
                onVerify={handleVerify}
                onNewSwap={handleNewSwap}
                verifying={verifying}
              />
            )}

            {isDev && (
              <details className="mt-4">
                <summary className="cursor-pointer text-xs text-white/20 hover:text-white/40">Debug (dev only)</summary>
                <pre className="mt-2 rounded-lg bg-white/[0.03] p-3 text-[10px] text-white/40 overflow-auto max-h-48">
                  {JSON.stringify({
                    address,
                    chainId,
                    tokenIn,
                    tokenOut,
                    tokenInAddress: TOKEN_ADDRESSES[tokenIn],
                    tokenOutAddress: TOKEN_ADDRESSES[tokenOut],
                    tokenInDecimals: TOKEN_DECIMALS[tokenIn],
                    tokenOutDecimals: TOKEN_DECIMALS[tokenOut],
                    amountIn,
                    estimatedOut,
                    phase,
                    balanceIn,
                    balanceOut,
                    approveTxHash,
                    swapTxHash,
                    error,
                    verification: verification ? {
                      deltaIn: verification.deltaIn.toString(),
                      deltaOut: verification.deltaOut.toString(),
                      deltaInFormatted: verification.deltaInFormatted,
                      deltaOutFormatted: verification.deltaOutFormatted,
                      balanceInFormatted: verification.balanceInFormatted,
                      balanceOutFormatted: verification.balanceOutFormatted,
                      transfersDetected: verification.transfersDetected,
                      transferInAmount: verification.transferInAmount,
                      transferOutAmount: verification.transferOutAmount,
                    } : null,
                    ignoredTransferReasons,
                  }, null, 2)}
                </pre>
              </details>
            )}
          </div>
        </div>

        <RecentSwaps history={history} onClear={clearHistory} />

        <p className="mt-6 text-center text-xs text-white/20">
          Powered by{' '}
          <a href="https://developers.circle.com" target="_blank" rel="noopener noreferrer" className="text-white/30 underline-offset-2 hover:text-white/50 hover:underline">Circle Swap Kit</a>
          {' '}&middot; Arc Testnet only
        </p>
      </div>
    </>
  )
}
