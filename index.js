import "dotenv/config";
import express from "express";
import { createPublicClient, http, isAddress, formatEther } from "viem";
import { base } from "viem/chains";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const app = express();
const PORT = process.env.PORT || 3000;

// Your self-custody wallet address (MetaMask / Rabby) to receive Base USDC
const PAY_TO_WALLET = process.env.PAY_TO_WALLET;
// Public x402 v2 facilitator for Base Mainnet (no API key required)
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.primer.systems";

if (!PAY_TO_WALLET) {
  console.error("ERROR: PAY_TO_WALLET environment variable is required.");
  process.exit(1);
}

// 1. Setup viem Public Client for Base Mainnet
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
});

// 2. Setup x402 v2 Payment Middleware
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitator).register(
  "eip155:8453", // Base Mainnet CAIP-2 ID
  new ExactEvmScheme()
);

const paidRoutes = {
  "GET /api/check/[address]": {
    accepts: {
      scheme: "exact",
      network: "eip155:8453",
      payTo: PAY_TO_WALLET,
      price: "$0.03",
    },
    description: "Real-time Base wallet activity & token smart contract risk check",
    mimeType: "application/json",
  },
};

// Free health check route (keeps Render free tier awake via UptimeRobot)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", network: "base-mainnet", timestamp: new Date().toISOString() });
});

// Apply x402 paywall to paid endpoints
app.use(paymentMiddleware(paidRoutes, resourceServer));

// 3. Paid Verification Route
app.get("/api/check/:address", async (req, res) => {
  const { address } = req.params;

  if (!isAddress(address)) {
    return res.status(400).json({ error: "Invalid EVM address format." });
  }

  try {
    // Run on-chain RPC checks + free GoPlus token security check in parallel
    const [bytecode, balanceWei, txCount, securityRes] = await Promise.all([
      publicClient.getCode({ address }),
      publicClient.getBalance({ address }),
      publicClient.getTransactionCount({ address }),
      fetch(`https://gopluslabs.io{address}`)
        .then((r) => r.json())
        .catch(() => null),
    ]);

    const isContract = Boolean(bytecode && bytecode !== "0x");
    const tokenData = securityRes?.result?.[address.toLowerCase()] || null;

    // Calculate simple risk signals for trading bots
    const flags = [];
    if (!isContract && txCount === 0) flags.push("FRESH_WALLET_ZERO_TX");
    if (tokenData) {
      if (tokenData.is_honeypot === "1") flags.push("HONEYPOT_DETECTED");
      if (tokenData.is_mintable === "1") flags.push("MINTABLE_SUPPLY");
      if (tokenData.is_proxy === "1") flags.push("UPGRADEABLE_PROXY");
      if (tokenData.is_blacklisted === "1") flags.push("BLACKLIST_FUNCTION");
      if (Number(tokenData.sell_tax || 0) > 0.1) flags.push("HIGH_SELL_TAX");
    }

    return res.json({
      address,
      chain: "base",
      type: isContract ? "SMART_CONTRACT" : "EOA_WALLET",
      onChain: {
        ethBalance: formatEther(balanceWei),
        transactionCount: txCount,
        hasBytecode: isContract,
      },
      tokenSecurity: tokenData
        ? {
            name: tokenData.token_name || null,
            symbol: tokenData.token_symbol || null,
            isHoneypot: tokenData.is_honeypot === "1",
            buyTax: tokenData.buy_tax || "0",
            sellTax: tokenData.sell_tax || "0",
            isOpenSource: tokenData.is_open_source === "1",
            holderCount: tokenData.holder_count || null,
          }
        : null,
      riskLevel: flags.includes("HONEYPOT_DETECTED")
        ? "CRITICAL"
        : flags.length > 0
          ? "MEDIUM"
          : "LOW",
      flags,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Verification error:", err);
    return res.status(500).json({ error: "Failed to verify address on-chain." });
  }
});

app.listen(PORT, () => {
  console.log(`x402 Crypto Risk API running on port ${PORT}`);
});

