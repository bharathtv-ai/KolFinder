require("dotenv").config();
const express = require("express");
const path = require("path");
const { investigateToken, startWalletMonitor, walletAlerts } = require("./walletIntel");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const trackedSet = new Set();
let monitorInterval = null;

// Analyze token → find early buyers → score them
app.get("/api/analyze", async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const { token } = req.query;
  if (!token || !token.startsWith("0x") || token.length !== 42) {
    return res.status(400).json({ error: "Please provide a valid 0x contract address (42 chars)" });
  }
  try {
    const result = await investigateToken(token);
    res.json(result);
  } catch (e) {
    console.error("[API] analyze error:", e.message);
    res.status(500).json({ error: e.message || "Analysis failed" });
  }
});

// Track a wallet
app.post("/api/track", async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: "No address provided" });
  trackedSet.add(address.toLowerCase());
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = await startWalletMonitor([...trackedSet], a =>
    console.log(`🚨 ${a.walletGrade} wallet bought $${a.tokenSymbol}`)
  );
  res.json({ ok: true, tracked: trackedSet.size });
});

// Untrack a wallet
app.post("/api/untrack", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  trackedSet.delete(req.query.address?.toLowerCase());
  res.json({ ok: true, tracked: trackedSet.size });
});

// Get live alerts
app.get("/api/alerts", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.json({ alerts: walletAlerts.slice(0, 50) });
});

// 404 → always JSON for /api routes
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "../public/index.html"));
});




app.get("/api/test", async (req, res) => {
  const axios = require("axios");
  const key = process.env.BASESCAN_API_KEY;
  const logs = [];

  logs.push(`KEY_FOUND: ${!!key}`);
  logs.push(`KEY_VALUE: ${key ? key.slice(0, -3).replace(/.(?=.{4})/g, '*') + 'xxx' : 'MISSING'}`);
  logs.push(`KEY_LENGTH: ${key?.length || 0}`);

  const url = `https://api.etherscan.io/v2/api?chainid=8453&module=account&action=tokentx&contractaddress=0x973daf0ab015c894ebe7efcf94824d5f9d0e3566&sort=asc&offset=5&apikey=${key}`;
  logs.push(`REQUEST_URL: ${url.replace(key, key?.slice(0,-3)+'xxx')}`);

  try {
    logs.push(`SENDING_REQUEST...`);
    const r = await axios.get(url, { timeout: 15000 });
    logs.push(`HTTP_STATUS: ${r.status}`);
    logs.push(`ETHERSCAN_STATUS: ${r.data?.status}`);
    logs.push(`ETHERSCAN_MESSAGE: ${r.data?.message}`);
    logs.push(`RESULT_COUNT: ${r.data?.result?.length || 0}`);
    logs.push(`RAW_RESPONSE: ${JSON.stringify(r.data).slice(0, 300)}`);
    res.json({ ok: true, logs });
  } catch (e) {
    logs.push(`REQUEST_FAILED: ${e.message}`);
    logs.push(`ERROR_CODE: ${e.code}`);
    logs.push(`ERROR_STATUS: ${e.response?.status}`);
    logs.push(`ERROR_BODY: ${JSON.stringify(e.response?.data || {}).slice(0, 200)}`);
    res.json({ ok: false, logs });
  }
});








app.listen(PORT, () => {
  console.log(`\n🔍 KOL Finder running → http://localhost:${PORT}`);
  console.log(`   Paste any Base token address to find KOL wallets\n`);
});
