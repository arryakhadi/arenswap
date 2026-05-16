'use client'

/**
 * CircleSwapBox — same-chain token swap on Arc Testnet via Circle Swap Kit.
 *
 * Adapter note:
 *   @circle-fin/adapter-viem-v2 exports `createViemAdapterFromProvider`, which
 *   accepts an EIP-1193 provider (window.ethereum / wagmi connector). This is
 *   the browser-wallet path — no private key is required or used.
 */

import { useState } from 'react'
import { useAccount, useWalletClient, useChainId, useSwitchChain } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { createSwapKitContext, swap } from '@circle-fin/swap-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'

// ─── Constants ─────────────────────────────────────────────────────────────────

const ARC_TESTNET_CHAIN_ID = 5042002
const ARC_TESTNET_EXPLORER = 'https://testnet.arcscan.app'

const SUPPORTED_TOKENS = ['USDC', 'EURC', 'cirBTC'] as const
type SupportedToken = (typeof SUPPORTED_TOKENS)[number]

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isValidAmount(value: string): boolean {
  const n = parseFloat(value)
  return value.trim() !== '' && isFinite(n) && n > 0
}

/** Narrow an unknown swap result to extract display fields safely. */
function extractSwapResult(result: unknown): {
  txHash?: string
  explorerUrl?: string
  amountOut?: string
  fees?: unknown
} {
  if (typeof result !== 'object' || result === null) return {}
  const r = result as Record<string, unknown>
  return {
    txHash: typeof r.txHash === 'string' ? r.txHash : undefined,
    explorerUrl:
      typeof r.txHash === 'string'
        ? `${ARC_TESTNET_EXPLORER}/tx/${r.txHash}`
        : undefined,
    amountOut: typeof r.amountOut === 'string' ? r.amountOut : undefined,
    fees: r.fees,
  }
}

// ─── Token selector ────────────────────────────────────────────────────────────

interface TokenSelectProps {
  label: string
  value: SupportedToken
  onChange: (v: SupportedToken) => void
  exclude?: SupportedToken
  disabled?: boolean
}

function TokenSelect({ label, value, onChange, exclude, disabled }: TokenSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium uppercase tracking-wider text-white/40">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SupportedToken)}
        disabled={disabled}
        className="rounded-xl border border-white/[0.08] bg-white/[0.06] px-3 py-2.5 text-sm font-semibold text-white outline-none transition-colors hover:border-white/[0.14] focus:border-blue-500/50 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={`Select ${label} token`}
      >
        {SUPPORTED_TOKENS.filter((t) => t !== exclude).map((t) => (
          <option key={t} value={t} className="bg-[#111318] text-white">
            {t}
          </option>
        ))}
      </select>
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

// ─── Main component ────────────────────────────────────────────────────────────

export default function CircleSwapBox() {
  const { isConnected } = useAccount()
  const chainId = useChainId()
  const { data: walletClient } = useWalletClient()
  const { switchChain, isPending: isSwitching } = useSwitchChain()

  const [tokenIn, setTokenIn] = useState<SupportedToken>('USDC')
  const [tokenOut, setTokenOut] = useState<SupportedToken>('EURC')
  const [amountIn, setAmountIn] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ReturnType<typeof extractSwapResult> | null>(null)
  const [rawResult, setRawResult] = useState<string | null>(null)

  const isOnArcTestnet = chainId === ARC_TESTNET_CHAIN_ID
  const kitKey = process.env.NEXT_PUBLIC_CIRCLE_KIT_KEY

  // ─── Validation ──────────────────────────────────────────────────────────────

  function getValidationError(): string | null {
    if (!isConnected) return 'Wallet not connected.'
    if (!isOnArcTestnet) return 'Please switch to Arc Testnet.'
    if (!walletClient) return 'Wallet client unavailable. Try reconnecting.'
    if (tokenIn === tokenOut) return 'tokenIn and tokenOut must be different.'
    if (!isValidAmount(amountIn)) return 'Enter a valid amount greater than zero.'
    if (!kitKey) return 'NEXT_PUBLIC_CIRCLE_KIT_KEY is not set in your environment.'
    return null
  }

  const validationError = getValidationError()
  const canSwap = validationError === null && !isLoading

  // ─── Swap handler ─────────────────────────────────────────────────────────────

  async function handleSwap() {
    if (!canSwap || !walletClient || !kitKey) return

    setIsLoading(true)
    setError(null)
    setResult(null)
    setRawResult(null)

    try {
      // Build the EIP-1193 provider from the wagmi wallet client's transport.
      // wagmi's WalletClient wraps an EIP-1193 provider under `.transport`.
      // We cast via `unknown` because the viem WalletClient type doesn't
      // directly expose EIP1193Provider, but the runtime object is compatible.
      const eip1193Provider = walletClient.transport as unknown as Parameters<
        typeof createViemAdapterFromProvider
      >[0]['provider']

      const adapter = await createViemAdapterFromProvider({
        provider: eip1193Provider,
      })

      const context = createSwapKitContext()

      const swapResult = await swap(context, {
        from: {
          adapter,
          chain: 'Arc_Testnet',
        },
        tokenIn,
        tokenOut,
        amountIn,
        config: {
          kitKey,
        },
      })

      const extracted = extractSwapResult(swapResult)
      setResult(extracted)
      setRawResult(JSON.stringify(swapResult, null, 2))
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'An unexpected error occurred.'
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

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
          {/* Header */}
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">
              Circle Swap Kit
            </h2>
            <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-400">
              Arc Testnet
            </span>
          </div>

          {/* Connect wallet prompt */}
          {!isConnected && (
            <div className="mb-4 flex flex-col items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-sm text-white/50">Connect your wallet to swap</p>
              <ConnectButton />
            </div>
          )}

          {/* Wrong chain warning */}
          {isConnected && !isOnArcTestnet && (
            <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <p className="mb-2 text-xs text-amber-400">
                Your wallet is on the wrong network. Switch to Arc Testnet to continue.
              </p>
              <button
                onClick={() => switchChain({ chainId: ARC_TESTNET_CHAIN_ID })}
                disabled={isSwitching}
                className="flex items-center gap-2 rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-300 transition-colors hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSwitching && <Spinner />}
                Switch to Arc Testnet
              </button>
            </div>
          )}

          {/* Swap form */}
          <div className="flex flex-col gap-4">
            {/* Token selectors */}
            <div className="grid grid-cols-2 gap-3">
              <TokenSelect
                label="From"
                value={tokenIn}
                onChange={(v) => {
                  setTokenIn(v)
                  setError(null)
                  setResult(null)
                }}
                exclude={tokenOut}
                disabled={isLoading}
              />
              <TokenSelect
                label="To"
                value={tokenOut}
                onChange={(v) => {
                  setTokenOut(v)
                  setError(null)
                  setResult(null)
                }}
                exclude={tokenIn}
                disabled={isLoading}
              />
            </div>

            {/* Amount input */}
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
                onChange={(e) => {
                  setAmountIn(e.target.value)
                  setError(null)
                  setResult(null)
                }}
                disabled={isLoading}
                min="0"
                step="any"
                aria-label={`Amount of ${tokenIn} to swap`}
                className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-xl font-semibold text-white outline-none placeholder:text-white/20 transition-colors hover:border-white/[0.14] focus:border-blue-500/50 focus:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>

            {/* Swap button */}
            <button
              onClick={handleSwap}
              disabled={!canSwap}
              aria-label={`Swap ${tokenIn} for ${tokenOut} via Circle Swap Kit`}
              className={`w-full rounded-2xl py-4 text-base font-semibold tracking-wide transition-all duration-200 ${
                canSwap
                  ? 'bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-500/25 hover:from-blue-400 hover:to-indigo-500 hover:shadow-blue-500/40 active:scale-[0.98]'
                  : 'cursor-not-allowed bg-white/[0.06] text-white/25'
              }`}
            >
              {isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner />
                  Swapping…
                </span>
              ) : (
                `Swap ${tokenIn} → ${tokenOut}`
              )}
            </button>

            {/* Inline validation hint (non-error) */}
            {validationError && !error && isConnected && isOnArcTestnet && (
              <p className="text-center text-xs text-white/30">{validationError}</p>
            )}
          </div>

          {/* Error display */}
          {error && (
            <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          {/* Success result */}
          {result && (
            <div className="mt-4 flex flex-col gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
              <p className="text-xs font-semibold text-emerald-400">Swap successful!</p>

              {result.txHash && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/40">Tx Hash</span>
                  <a
                    href={result.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="max-w-[180px] truncate text-xs text-emerald-400 underline hover:text-emerald-300"
                  >
                    {result.txHash}
                  </a>
                </div>
              )}

              {result.amountOut && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/40">Amount Out</span>
                  <span className="text-xs font-medium text-white/70">
                    {result.amountOut} {tokenOut}
                  </span>
                </div>
              )}

              {result.fees !== undefined && (
                <div className="flex items-start justify-between gap-2">
                  <span className="shrink-0 text-xs text-white/40">Fees</span>
                  <span className="text-right text-xs text-white/50">
                    {JSON.stringify(result.fees)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Raw JSON debug output */}
          {rawResult && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-white/20 hover:text-white/40">
                Raw result (debug)
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-white/[0.03] p-3 text-[10px] text-white/40">
                {rawResult}
              </pre>
            </details>
          )}
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-white/20">
        Powered by{' '}
        <a
          href="https://developers.circle.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-white/30 underline-offset-2 hover:text-white/50 hover:underline"
        >
          Circle Swap Kit
        </a>
        {' '}· Arc Testnet only
      </p>
    </div>
  )
}
