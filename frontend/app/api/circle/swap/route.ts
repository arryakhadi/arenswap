/**
 * POST /api/circle/swap
 *
 * Server-side proxy for the Circle Stablecoin Service createSwap endpoint.
 *
 * Root cause of the CORS error:
 *   The Circle SDK sends an `X-User-Agent` header that Circle's CORS preflight
 *   does not allow from browser origins. By making the request here on the
 *   server (Node.js), there are no CORS restrictions and the header is allowed.
 *
 * Flow:
 *   1. Browser POSTs swap parameters to this route.
 *   2. This route calls POST https://api.circle.com/v1/stablecoinKits/swap
 *      with the CIRCLE_KIT_KEY (server-only env var).
 *   3. Circle returns an EVM transaction payload (target, calldata, value,
 *      amountToApprove, etc.).
 *   4. This route returns that payload to the browser.
 *   5. The browser executes the on-chain approve + swap using the user's wallet.
 *
 * No private key is used. The kit key is never sent to the browser.
 *
 * Environment variables (server-only):
 *   CIRCLE_KIT_KEY  — Circle App Kit key, format: KIT_KEY:{keyId}:{keySecret}
 */

import { NextRequest, NextResponse } from 'next/server'

// ─── Constants ────────────────────────────────────────────────────────────────

const CIRCLE_API_BASE = 'https://api.circle.com'
const CIRCLE_SWAP_URL = `${CIRCLE_API_BASE}/v1/stablecoinKits/swap`

// Arc Testnet token addresses (canonical, from Circle SDK token registry)
const TOKEN_ADDRESSES: Record<string, string> = {
  USDC:   '0x3600000000000000000000000000000000000000',
  EURC:   '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  // cirBTC address from Circle SDK (CIRBTC.locators[Blockchain.Arc_Testnet])
  cirBTC: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
}

const TOKEN_DECIMALS: Record<string, number> = {
  USDC:   6,
  EURC:   6,
  cirBTC: 8,
}

const ALLOWED_TOKENS = new Set(Object.keys(TOKEN_ADDRESSES))
const ALLOWED_CHAINS = new Set(['Arc_Testnet'])

// ─── Input validation helpers ─────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isEvmAddress(v: unknown): v is string {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
}

function isPositiveNumberString(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const n = parseFloat(v)
  return isFinite(n) && n > 0
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Validate server-side kit key ───────────────────────────────────────
  const kitKey = process.env.CIRCLE_KIT_KEY

  if (!kitKey) {
    console.error('[circle/swap] CIRCLE_KIT_KEY is not set')
    return NextResponse.json(
      { error: 'Server configuration error: CIRCLE_KIT_KEY is not set. Add it in Vercel Environment Variables.' },
      { status: 500 },
    )
  }

  if (!kitKey.startsWith('KIT_KEY:')) {
    console.error('[circle/swap] CIRCLE_KIT_KEY has invalid format')
    return NextResponse.json(
      {
        error:
          'Server configuration error: CIRCLE_KIT_KEY has an invalid format. ' +
          'Expected: KIT_KEY:{keyId}:{keySecret}. Do not use a regular Circle API key.',
      },
      { status: 500 },
    )
  }

  // ── 2. Parse request body ─────────────────────────────────────────────────
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 })
  }

  const {
    tokenIn,
    tokenOut,
    amountIn,
    fromAddress,
    toAddress,
    chain,
  } = body as Record<string, unknown>

  // ── 3. Validate inputs ────────────────────────────────────────────────────
  if (!isNonEmptyString(tokenIn) || !ALLOWED_TOKENS.has(tokenIn)) {
    return NextResponse.json(
      { error: `Invalid tokenIn. Allowed: ${[...ALLOWED_TOKENS].join(', ')}` },
      { status: 400 },
    )
  }

  if (!isNonEmptyString(tokenOut) || !ALLOWED_TOKENS.has(tokenOut)) {
    return NextResponse.json(
      { error: `Invalid tokenOut. Allowed: ${[...ALLOWED_TOKENS].join(', ')}` },
      { status: 400 },
    )
  }

  if (tokenIn === tokenOut) {
    return NextResponse.json(
      { error: 'tokenIn and tokenOut must be different.' },
      { status: 400 },
    )
  }

  if (!isPositiveNumberString(amountIn)) {
    return NextResponse.json(
      { error: 'amountIn must be a positive number string (e.g. "1.5").' },
      { status: 400 },
    )
  }

  if (!isEvmAddress(fromAddress)) {
    return NextResponse.json(
      { error: 'fromAddress must be a valid EVM address (0x...).' },
      { status: 400 },
    )
  }

  if (!isEvmAddress(toAddress)) {
    return NextResponse.json(
      { error: 'toAddress must be a valid EVM address (0x...).' },
      { status: 400 },
    )
  }

  const resolvedChain = isNonEmptyString(chain) ? chain : 'Arc_Testnet'
  if (!ALLOWED_CHAINS.has(resolvedChain)) {
    return NextResponse.json(
      { error: `Invalid chain. Allowed: ${[...ALLOWED_CHAINS].join(', ')}` },
      { status: 400 },
    )
  }

  // ── 4. Resolve token addresses and convert amount to base units ───────────
  const tokenInAddress  = TOKEN_ADDRESSES[tokenIn]
  const tokenOutAddress = TOKEN_ADDRESSES[tokenOut]

  // Guard: reject any zero or placeholder address — prevents sending invalid
  // transactions if a token entry was accidentally left as a stub.
  const ZERO_ADDRESSES = new Set([
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000001',
  ])
  if (!tokenInAddress || ZERO_ADDRESSES.has(tokenInAddress)) {
    return NextResponse.json(
      { error: `${tokenIn} is not enabled yet because the app does not have an official Arc Testnet token address.` },
      { status: 400 },
    )
  }
  if (!tokenOutAddress || ZERO_ADDRESSES.has(tokenOutAddress)) {
    return NextResponse.json(
      { error: `${tokenOut} is not enabled yet because the app does not have an official Arc Testnet token address.` },
      { status: 400 },
    )
  }

  const decimals = TOKEN_DECIMALS[tokenIn] ?? 6

  let amountBaseUnits: string
  try {
    const parsed = parseFloat(amountIn as string)
    const raw = BigInt(Math.round(parsed * 10 ** decimals))
    if (raw <= BigInt(0)) throw new Error('Amount rounds to zero')
    amountBaseUnits = raw.toString()
  } catch {
    return NextResponse.json(
      { error: 'amountIn could not be converted to base units.' },
      { status: 400 },
    )
  }

  // ── 5. Call Circle Stablecoin Service API server-side ─────────────────────
  // Running this on the server avoids the browser CORS restriction caused by
  // the SDK injecting an X-User-Agent header that Circle's preflight rejects.
  const requestBody = {
    tokenInAddress,
    tokenInChain:  resolvedChain,
    tokenOutAddress,
    tokenOutChain: resolvedChain,
    fromAddress,
    toAddress,
    amount: amountBaseUnits,
  }

  let circleRes: Response
  try {
    circleRes = await fetch(CIRCLE_SWAP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${kitKey}`,
        // Include X-User-Agent as the SDK does — this is fine server-side
        'X-User-Agent': 'arenswap/1.0 (server-proxy)',
      },
      body: JSON.stringify(requestBody),
    })
  } catch (fetchErr: unknown) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
    console.error('[circle/swap] Network error calling Circle API:', msg)
    return NextResponse.json(
      { error: 'Network error reaching Circle Stablecoin Service.' },
      { status: 502 },
    )
  }

  // ── 6. Parse Circle response ──────────────────────────────────────────────
  let circleData: unknown
  try {
    circleData = await circleRes.json()
  } catch {
    console.error('[circle/swap] Circle API returned non-JSON response, status:', circleRes.status)
    return NextResponse.json(
      { error: `Circle API returned an unexpected response (HTTP ${circleRes.status}).` },
      { status: 502 },
    )
  }

  if (!circleRes.ok) {
    // Surface a safe subset of the Circle error — never expose the kit key
    const circleError =
      typeof circleData === 'object' &&
      circleData !== null &&
      'message' in circleData
        ? String((circleData as Record<string, unknown>).message)
        : `Circle API error (HTTP ${circleRes.status})`

    console.error('[circle/swap] Circle API error:', circleRes.status, circleError)
    return NextResponse.json(
      { error: circleError },
      { status: circleRes.status >= 400 && circleRes.status < 500 ? 400 : 502 },
    )
  }

  // ── 7. Return the transaction payload to the browser ─────────────────────
  // The browser will use this to execute the on-chain approve + swap.
  // We never return the kit key or any server secret.
  const d = circleData as Record<string, unknown>

  // Format estimatedAmount from base units to a human-readable decimal string.
  // Circle returns estimatedAmount as a base-unit integer string (e.g. "1082974"
  // for 1.082974 USDC). We format it here so the browser never has to guess decimals.
  const tokenOutDecimals = TOKEN_DECIMALS[tokenOut as string] ?? 6
  let estimatedAmountFormatted: string | null = null
  if (d.estimatedAmount && typeof d.estimatedAmount === 'string') {
    try {
      const raw = BigInt(d.estimatedAmount)
      const divisor = Math.pow(10, tokenOutDecimals)
      const human = Number(raw) / divisor
      estimatedAmountFormatted = human.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: tokenOutDecimals,
      })
    } catch {
      estimatedAmountFormatted = null
    }
  }

  return NextResponse.json({
    ok: true,
    tokenIn,
    tokenOut,
    tokenOutDecimals,
    amountIn: amountIn as string,
    amountBaseUnits,
    estimatedAmount: d.estimatedAmount ?? null,          // raw base units (kept for reference)
    estimatedAmountFormatted,                             // human-readable decimal string
    stopLimit:       d.stopLimit ?? null,
    fromAddress:     d.fromAddress ?? fromAddress,
    toAddress:       d.toAddress ?? toAddress,
    transaction:     d.transaction ?? null,
    fees:            d.fees ?? null,
  })
}
