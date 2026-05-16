// Contract addresses — Arc Testnet
export const ARENSWAP_ADDRESS: `0x${string}` = '0x936B1516B784C3E2CC064e645BEBB614781D13Bd'
export const USDC_ADDRESS:     `0x${string}` = '0x3600000000000000000000000000000000000000'
export const EURC_ADDRESS:     `0x${string}` = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'

// ArenSwap ABI — minimal fragments needed by the frontend
export const ARENSWAP_ABI = [
  {
    name: 'swapUSDCToEURC',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs:  [{ name: 'usdcAmount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'swapEURCToUSDC',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs:  [{ name: 'eurcAmount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'swapRate',
    type: 'function',
    stateMutability: 'view',
    inputs:  [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// ERC-20 ABI — minimal fragments needed by the frontend
export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs:  [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const
