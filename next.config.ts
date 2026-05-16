import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @circle-fin/swap-kit includes Solana-specific imports (@coral-xyz/anchor)
  // that are not needed for EVM (Arc Testnet) swaps. Alias the missing package
  // to an empty stub so the browser bundle can be built without installing it.
  turbopack: {
    resolveAlias: {
      "@coral-xyz/anchor": "./src/empty-module.js",
    },
  },
};

export default nextConfig;
