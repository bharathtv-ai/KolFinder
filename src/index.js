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

app.listen(PORT, () => {
  console.log(`\n🔍 KOL Finder running → http://localhost:${PORT}`);
  console.log(`   Paste any Base token address to find KOL wallets\n`);
});
