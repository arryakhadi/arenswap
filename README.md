# Arenswap

Arenswap is a Next.js Arc Testnet transaction utility for supported Circle tokens. It keeps the stable Circle Swap Kit flow intact, adds wallet-signed send and management tools, and verifies transaction outcomes from real receipts, balances, allowances, and transfer events where possible.

## Features

- Swap with Circle Swap Kit
- Send Token
- Batch Send
- Transaction History
- Approval Manager
- Faucet Helper / Top-up Guide
- Transaction Receipt Page
- Address Book
- Portfolio + Quick Actions

## Project Structure

```text
arenswap/
  frontend/   Next.js app, wallet UI, Circle swap proxy route, Arc Testnet config
  contracts/  Foundry contracts workspace and tests
```

Vercel builds and deploys from `frontend/`.

## Network And Tokens

Arenswap is Arc Testnet only.

Supported tokens:

- `USDC`
- `EURC`
- `cirBTC`

The app uses canonical Arc Testnet token addresses from the implementation. Do not replace them with placeholder or fake addresses.

## Frontend Development

Install dependencies and start the local app:

```bash
cd frontend
npm install
npm run dev
```

The app runs on the Next.js local dev URL shown in the terminal, usually `http://localhost:3000`.

Build the frontend:

```bash
cd frontend
npm run build
```

Run lint:

```bash
cd frontend
npm run lint
```

## Vercel Deployment

Use these Vercel project settings:

```text
Root Directory: frontend
Framework Preset: Next.js
Install Command: npm install
Build Command: npm run build
Output Directory: .next
```

Required Vercel environment variable:

```text
CIRCLE_KIT_KEY=KIT_KEY:...
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...
```

`CIRCLE_KIT_KEY` is server-side only. Do not prefix it with `NEXT_PUBLIC_`, do not render it in the browser, and do not send it to the wallet. The frontend calls `frontend/app/api/circle/swap/route.ts`, and that server route calls Circle with the kit key.

`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is required for mobile wallet connection through WalletConnect and wallet deep links. Get it from WalletConnect/Reown Cloud, add it to local `frontend/.env.local`, and add it to Vercel Environment Variables. This value is public and safe to expose, unlike `CIRCLE_KIT_KEY`.

Do not use private keys in this project. Swaps, sends, batch sends, and revokes are executed by the connected user wallet only.

## Transaction Integrity

The app must not mark a transaction successful just because a wallet request was submitted.

For swaps:

- The result card shows approval and swap transaction hashes when available.
- The Arcscan link opens the final swap transaction.
- Transfer events are decoded from the receipt and small service or gas fee transfers are ignored.
- The input token balance must decrease by the real swap input amount.
- The output token balance must increase.

For sends and batch sends:

- The wallet signs each transfer.
- The app waits for the transaction receipt.
- The app checks the expected ERC-20 `Transfer` event where possible.
- If a receipt confirms but verification fails, the UI records a verification warning instead of fake success.

For approvals:

- The app shows only the known Circle swap adapter spender from the current configuration.
- Revoke uses `approve(spender, 0)`.
- The app refetches allowance after confirmation and records whether it reached zero.

## Verifying Transactions

Use the compact swap status link, Recent Transactions, `/tx/[hash]` receipt page, and Arcscan links to verify real transaction state. Local history is stored in browser `localStorage` and is only a convenience cache; Arcscan and receipt data are the source of truth for on-chain state.

## Faucet / Top-up

Use the global Faucet shortcut next to the Arc Testnet badge to open Circle Faucet.
