'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useState, useEffect, useRef } from 'react'
import { useAccount, useChainId } from 'wagmi'
import useSwap, { encodeUsdcAmount, computeReceiveAmount } from '@/app/hooks/useSwap'
import CircleSwapBox from '@/app/components/CircleSwapBox'

// ─── Token metadata ────────────────────────────────────────────────────────────

const USDC_COLOR = '#2775CA'
const EURC_COLOR = '#1A56DB'

function UsdcIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill={USDC_COLOR} />
      <path
        d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.232-2.192-.696-2.192-1.508 0-.812.58-1.348 1.736-1.348 1.04 0 1.62.348 1.912 1.216a.38.38 0 00.36.26h.824a.37.37 0 00.368-.376v-.044a2.96 2.96 0 00-2.656-2.42V9.5a.38.38 0 00-.376-.376h-.784a.38.38 0 00-.376.376v1.22c-1.624.232-2.68 1.3-2.68 2.68 0 2.02 1.248 2.78 3.808 3.084 1.7.26 2.224.652 2.224 1.564 0 .912-.812 1.536-1.912 1.536-1.508 0-2.02-.636-2.196-1.508a.38.38 0 00-.368-.288h-.856a.37.37 0 00-.368.376v.044c.232 1.624 1.304 2.768 3.016 3.044v1.248a.38.38 0 00.376.376h.784a.38.38 0 00.376-.376v-1.22c1.652-.26 2.82-1.42 2.82-2.856z"
        fill="white"
      />
    </svg>
  )
}

function EurcIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill={EURC_COLOR} />
      <text
        x="16"
        y="21"
        textAnchor="middle"
        fontSize="14"
        fontWeight="bold"
        fill="white"
        fontFamily="Arial, sans-serif"
      >
        €
      </text>
    </svg>
  )
}

// ─── Navbar ────────────────────────────────────────────────────────────────────

function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/[0.06] bg-[#0a0b0f]/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/25">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M7 16l5-8 5 8M9.5 12h5"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <span className="text-lg font-semibold tracking-tight text-white">
            Aren<span className="text-blue-400">swap</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 sm:flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            <span className="text-xs font-medium text-emerald-400">Arc Testnet</span>
          </div>
          <ConnectButton chainStatus="icon" showBalance={false} accountStatus="avatar" />
        </div>
      </div>
    </header>
  )
}

// ─── Token input ───────────────────────────────────────────────────────────────

interface TokenInputProps {
  label: string
  symbol: 'USDC' | 'EURC'
  value: string
  onChange?: (v: string) => void
  readOnly?: boolean
  balance?: string
}

function TokenInput({ label, symbol, value, onChange, readOnly = false, balance }: TokenInputProps) {
  const Icon = symbol === 'USDC' ? UsdcIcon : EurcIcon
  const color = symbol === 'USDC' ? 'text-blue-400' : 'text-indigo-400'

  return (
    <div
      className={`group relative rounded-2xl border bg-white/[0.03] p-4 transition-all duration-200 ${
        readOnly
          ? 'border-white/[0.06]'
          : 'border-white/[0.08] hover:border-white/[0.14] focus-within:border-blue-500/50 focus-within:bg-white/[0.05]'
      }`}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-white/40">{label}</span>
        {balance !== undefined && (
          <span className="text-xs text-white/30">
            Balance: <span className="text-white/50">{balance}</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <input
          type="number"
          inputMode="decimal"
          placeholder="0.00"
          value={value}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          readOnly={readOnly}
          min="0"
          step="any"
          aria-label={`${label} amount in ${symbol}`}
          className={`w-full bg-transparent text-2xl font-semibold tracking-tight text-white outline-none placeholder:text-white/20 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
            readOnly ? 'cursor-default' : ''
          }`}
        />
        <div className="flex shrink-0 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.06] px-3 py-2">
          <Icon size={20} />
          <span className={`text-sm font-semibold ${color}`}>{symbol}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Swap arrow ────────────────────────────────────────────────────────────────

function SwapArrow() {
  return (
    <div className="flex justify-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-[#0a0b0f] text-white/40 shadow-lg transition-colors hover:border-white/[0.14] hover:text-white/70">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 5v14M5 12l7 7 7-7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  )
}

// ─── Rate display ──────────────────────────────────────────────────────────────

function RateDisplay({ rate }: { rate: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
      <span className="text-xs text-white/30">Exchange rate</span>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-white/60">{rate}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-white/30" aria-hidden="true">
          <path
            d="M4 12h16M4 12l4-4M4 12l4 4M20 12l-4-4M20 12l-4 4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  )
}

// ─── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  )
}

// ─── Swap card ─────────────────────────────────────────────────────────────────

function SwapCard() {
  const [payAmount, setPayAmount] = useState('')

  const {
    swapRate,
    isRateLoading,
    isRateError,
    needsApproval,
    status,
    error,
    successTxHash,
    executeSwap,
    resetError,
  } = useSwap(payAmount)

  const { isConnected } = useAccount()
  const chainId = useChainId()

  // Auto-dismiss success toast after 10 seconds
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (status === 'success') {
      toastTimerRef.current = setTimeout(() => resetError(), 10_000)
    }
    return () => {
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current)
        toastTimerRef.current = null
      }
    }
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Derived values
  const isPending = status === 'approving' || status === 'swapping'

  const receiveAmount =
    swapRate !== undefined &&
    swapRate > BigInt(0) &&
    payAmount !== '' &&
    Number(payAmount) > 0
      ? computeReceiveAmount(payAmount, swapRate).toFixed(4)
      : ''

  const rateDisplay = isRateLoading
    ? '—'
    : isRateError || !swapRate || swapRate === BigInt(0)
      ? 'Rate unavailable'
      : `1 USDC ≈ ${(Number(swapRate) / 1e6).toFixed(4)} EURC`

  const hasAmount = payAmount !== '' && Number(payAmount) > 0

  // ─── Button state machine ───────────────────────────────────────────────────
  let buttonLabel: React.ReactNode = 'Swap'
  let buttonDisabled = false
  let buttonOnClick: (() => void) | undefined = () => executeSwap(payAmount)

  if (!isConnected) {
    buttonLabel = 'Connect Wallet'
    buttonDisabled = true
    buttonOnClick = undefined
  } else if (chainId !== 5042002) {
    buttonLabel = 'Switch to Arc Testnet'
    buttonDisabled = true
    buttonOnClick = undefined
  } else if (status === 'approving') {
    buttonLabel = (
      <span className="flex items-center justify-center gap-2">
        <Spinner />Approving USDC…
      </span>
    )
    buttonDisabled = true
    buttonOnClick = undefined
  } else if (status === 'swapping') {
    buttonLabel = (
      <span className="flex items-center justify-center gap-2">
        <Spinner />Swapping…
      </span>
    )
    buttonDisabled = true
    buttonOnClick = undefined
  } else {
    let encodedAmount: bigint
    let amountTooLarge = false
    try {
      encodedAmount = encodeUsdcAmount(payAmount)
    } catch {
      encodedAmount = BigInt(0)
      amountTooLarge = true
    }
    if (amountTooLarge) {
      buttonLabel = 'Amount too large'
      buttonDisabled = true
      buttonOnClick = undefined
    } else if (encodedAmount === BigInt(0)) {
      buttonLabel = 'Enter an amount'
      buttonDisabled = true
      buttonOnClick = undefined
    } else if (needsApproval) {
      buttonLabel = 'Approve USDC'
      buttonDisabled = false
      buttonOnClick = () => executeSwap(payAmount)
    }
    // else: buttonLabel stays 'Swap', buttonDisabled stays false
  }

  return (
    <div className="w-full max-w-md">
      <div className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-[#111318] shadow-2xl shadow-black/60">
        {/* Top gradient accent */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgba(59,130,246,0.5) 40%, rgba(99,102,241,0.5) 60%, transparent)',
          }}
          aria-hidden="true"
        />

        <div className="p-5">
          {/* Card header */}
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">Swap</h2>
            <button
              aria-label="Swap settings"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/60"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* Token inputs */}
          <div className="flex flex-col gap-1.5">
            <TokenInput
              label="Pay"
              symbol="USDC"
              value={payAmount}
              onChange={(v) => {
                setPayAmount(v)
                resetError()
              }}
              readOnly={isPending}
              balance="—"
            />
            <SwapArrow />
            <TokenInput
              label="Receive"
              symbol="EURC"
              value={receiveAmount}
              readOnly
            />
          </div>

          {/* Rate display */}
          {hasAmount && (
            <div className="mt-3">
              <RateDisplay rate={rateDisplay} />
            </div>
          )}

          {/* Swap button */}
          <button
            disabled={buttonDisabled}
            onClick={buttonOnClick}
            aria-label="Swap USDC for EURC"
            className={`mt-4 w-full rounded-2xl py-4 text-base font-semibold tracking-wide transition-all duration-200 ${
              !buttonDisabled
                ? 'bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-500/25 hover:from-blue-400 hover:to-indigo-500 hover:shadow-blue-500/40 active:scale-[0.98]'
                : 'cursor-not-allowed bg-white/[0.06] text-white/25'
            }`}
          >
            {buttonLabel}
          </button>

          {/* Success toast */}
          {status === 'success' && successTxHash && (
            <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
              <p className="text-xs font-medium text-emerald-400">
                Swap successful!{' '}
                <a
                  href={`https://testnet.arcscan.app/tx/${successTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-emerald-300"
                >
                  View on ArcScan
                </a>
              </p>
            </div>
          )}

          {/* Inline error */}
          {error && status === 'error' && (
            <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-white/20">
        Connect wallet to execute swaps on Arc Testnet.
      </p>
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-[#0a0b0f]">
      <div
        className="pointer-events-none fixed inset-0 z-0"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(59,130,246,0.12) 0%, transparent 70%)',
        }}
      />

      <Navbar />

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 py-16">
        <div className="mb-10 text-center">
          <h1 className="mb-3 text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Swap stablecoins{' '}
            <span className="bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
              instantly
            </span>
          </h1>
          <p className="text-base text-white/40 sm:text-lg">
            USDC → EURC on Arc Network. Sub-second finality. Zero slippage.
          </p>
        </div>

        <SwapCard />

        {/* ── Circle Swap Kit integration ── */}
        <div className="mt-12 w-full max-w-md">
          <div className="mb-6 text-center">
            <h2 className="mb-1 text-xl font-semibold text-white">
              Circle Swap Kit
            </h2>
            <p className="text-sm text-white/40">
              Swap USDC, EURC, and cirBTC via the official Circle Swap Kit
            </p>
          </div>
          <CircleSwapBox />
        </div>
      </main>

      <footer className="relative z-10 border-t border-white/[0.04] py-6">
        <p className="text-center text-xs text-white/20">
          Built on{' '}
          <a
            href="https://docs.arc.io"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/30 underline-offset-2 hover:text-white/50 hover:underline"
          >
            Arc Network
          </a>{' '}
          · Powered by Circle USDC &amp; EURC
        </p>
      </footer>
    </div>
  )
}
