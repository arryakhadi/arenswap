'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import TransactionDashboard from '@/app/components/TransactionDashboard'

function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/[0.07] bg-[#080a10]/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/25">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M7 16l5-8 5 8M9.5 12h5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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
          <a
            href="https://faucet.circle.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-blue-300/15 bg-blue-400/[0.07] px-3 py-1 text-xs font-semibold text-blue-100/70 transition-colors hover:border-blue-300/25 hover:bg-blue-400/[0.11] hover:text-blue-50"
          >
            Faucet
          </a>
          <ConnectButton chainStatus="icon" showBalance={false} accountStatus="avatar" />
        </div>
      </div>
    </header>
  )
}

export default function Home() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-x-hidden bg-[#080a10]">
      <div
        className="pointer-events-none fixed inset-0 z-0"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(ellipse 70% 38% at 50% -8%, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.06) 42%, transparent 76%), radial-gradient(ellipse 42% 32% at 78% 12%, rgba(99,102,241,0.14) 0%, transparent 72%), radial-gradient(ellipse 56% 34% at 50% 92%, rgba(79,70,229,0.10) 0%, transparent 72%), linear-gradient(180deg, #090b12 0%, #080a10 52%, #07080d 100%)',
        }}
      />
      <div
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.018]"
        aria-hidden="true"
        style={{
          backgroundImage: 'linear-gradient(rgba(190,210,255,0.55) 1px, transparent 1px), linear-gradient(90deg, rgba(190,210,255,0.55) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'linear-gradient(to bottom, black, transparent 58%)',
        }}
      />

      <Navbar />

      <main className="relative z-10 flex flex-1 flex-col items-center px-4 pb-12 pt-6 sm:pt-8">
        <div className="mb-5 text-center">
          <h1 className="mb-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Arc Testnet{' '}
            <span className="bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
              transactions
            </span>
          </h1>
          <p className="mx-auto max-w-xl text-sm text-white/48 sm:text-base">
            Swap, send, manage approvals, and inspect local receipts for USDC, EURC, and cirBTC.
          </p>
        </div>

        <TransactionDashboard />
      </main>

      <footer className="relative z-10 border-t border-white/[0.05] py-6">
        <p className="text-center text-xs text-white/20">
          Built on{' '}
          <a href="https://docs.arc.io" target="_blank" rel="noopener noreferrer" className="text-white/30 underline-offset-2 hover:text-white/50 hover:underline">
            Arc Network
          </a>{' '}
          · Powered by Circle USDC &amp; EURC
        </p>
      </footer>
    </div>
  )
}
