'use client'

import { decodeEventLog, formatUnits, parseUnits, zeroAddress } from 'viem'

export const ARC_TESTNET_CHAIN_ID = 5042002
export const ARC_TESTNET_NAME = 'Arc Testnet'
export const ARC_TESTNET_EXPLORER = 'https://testnet.arcscan.app'
export const CIRCLE_SWAP_ADAPTER = '0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b' as const

export const SUPPORTED_TOKENS = ['USDC', 'EURC', 'cirBTC'] as const
export type SupportedToken = (typeof SUPPORTED_TOKENS)[number]

export interface TokenMetadata {
  symbol: SupportedToken
  decimals: number
  address: `0x${string}`
  isNative: boolean
}

export const TOKENS: Record<SupportedToken, TokenMetadata> = {
  USDC: {
    symbol: 'USDC',
    decimals: 6,
    address: '0x3600000000000000000000000000000000000000',
    isNative: false,
  },
  EURC: {
    symbol: 'EURC',
    decimals: 6,
    address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    isNative: false,
  },
  cirBTC: {
    symbol: 'cirBTC',
    decimals: 8,
    address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
    isNative: false,
  },
}

export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'Transfer',
    type: 'event',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

export function explorerTxUrl(hash: string): string {
  return `${ARC_TESTNET_EXPLORER}/tx/${hash}`
}

export function explorerAddressUrl(address: string): string {
  return `${ARC_TESTNET_EXPLORER}/address/${address}`
}

export function truncateHash(hash: string, chars = 6): string {
  if (hash.length <= chars * 2 + 2) return hash
  return `${hash.slice(0, chars + 2)}...${hash.slice(-4)}`
}

export function formatTokenAmount(raw: bigint, token: SupportedToken): string {
  const formatted = formatUnits(raw, TOKENS[token].decimals)
  const n = Number(formatted)
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n < 0.0001) return '< 0.0001'
  return n.toLocaleString(undefined, { maximumFractionDigits: TOKENS[token].decimals })
}

export function parseTokenAmount(value: string, token: SupportedToken): bigint | null {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  try {
    const parsed = parseUnits(trimmed, TOKENS[token].decimals)
    return parsed > BigInt(0) ? parsed : null
  } catch {
    return null
  }
}

export function tokenAddress(token: SupportedToken): `0x${string}` {
  return TOKENS[token].address
}

export function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === zeroAddress.toLowerCase()
}

export function decodeExpectedTransfer(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  token: SupportedToken,
  from: string,
  to: string,
  amount: bigint,
): boolean {
  const expectedToken = tokenAddress(token).toLowerCase()
  const expectedFrom = from.toLowerCase()
  const expectedTo = to.toLowerCase()

  for (const log of logs) {
    if (log.address.toLowerCase() !== expectedToken) continue
    try {
      const decoded = decodeEventLog({
        abi: ERC20_ABI,
        eventName: 'Transfer',
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: log.data as `0x${string}`,
      })
      const args = decoded.args as { from: string; to: string; value: bigint }
      if (
        args.from.toLowerCase() === expectedFrom &&
        args.to.toLowerCase() === expectedTo &&
        args.value === amount
      ) {
        return true
      }
    } catch {
      // Non-Transfer logs are ignored.
    }
  }

  return false
}
