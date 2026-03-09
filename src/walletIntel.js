const axios = require("axios");

const BASESCAN_KEY = process.env.BASESCAN_API_KEY || "";
const EARLY_BUYER_WINDOW_HOURS = 6;
const MIN_WIN_MULTIPLIER = 5;
const MIN_TRADES_TO_SCORE = 2;
const TOP_EARLY_BUYERS = 15;

// ── Basescan ──────────────────────────────────────────────────────────────
async function basescanGet(params) {
  try {
    const qs = new URLSearchParams({
      apikey: BASESCAN_KEY || "YourApiKeyToken",
      ...params,
    }).toString();
    const res = await axios.get(`https://api.basescan.org/api?${qs}`, { timeout: 15000 });
    if (res.data?.status === "1") return res.data.result;
    if (res.data?.message) console.log("[Basescan]", res.data.message);
    return [];
  } catch (e) {
    console.error("[Basescan]", e.message);
    return [];
  }
}

// ── DexScreener ───────────────────────────────────────────────────────────
async function getTokenInfo(tokenAddress) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { timeout: 10000 }
    );
    const pairs = (res.data?.pairs || [])
      .filter(p => p.chainId === "base")
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs[0] || null;
  } catch (e) {
    console.error("[DexScreener]", e.message);
    return null;
  }
}

// ── Historical price via GeckoTerminal OHLCV ─────────────────────────────
async function getTokenPriceAtTime(tokenAddress, timestampMs) {
  try {
    const res = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress}/ohlcv/hour?limit=168`,
      { timeout: 10000 }
    );
    const candles = res.data?.data?.attributes?.ohlcv_list || [];
    if (!candles.length) return 0;
    const ts = timestampMs / 1000;
    const closest = candles.reduce((best, c) =>
      Math.abs(c[0] - ts) < Math.abs(best[0] - ts) ? c : best
    , candles[0]);
    return closest[4] || 0; // close price
  } catch {
    return 0;
  }
}

// ── Step 1: Find early buyers ─────────────────────────────────────────────
async function findEarlyBuyers(tokenAddress) {
  console.log(`[WalletIntel] Looking up token ${tokenAddress}...`);

  const tokenInfo = await getTokenInfo(tokenAddress);
  if (!tokenInfo) return { error: "Token not found on Base — check the address and make sure it has a DEX pair" };

  const pairCreatedAt = tokenInfo.pairCreatedAt || (Date.now() - 86400000);
  const currentPrice = parseFloat(tokenInfo.priceUsd || 0);
  const currentMcap = tokenInfo.fdv || tokenInfo.marketCap || 0;
  const symbol = tokenInfo.baseToken?.symbol || "???";

  console.log(`[WalletIntel] Found: ${symbol} | Price: $${currentPrice} | Pair created: ${new Date(pairCreatedAt).toISOString()}`);

  // Get block at launch time
  const launchTs = Math.floor(pairCreatedAt / 1000);
  const endTs = Math.floor((pairCreatedAt + EARLY_BUYER_WINDOW_HOURS * 3600 * 1000) / 1000);

  const startBlock = await getBlockAtTime(launchTs);
  const endBlock = await getBlockAtTime(endTs);
  console.log(`[WalletIntel] Fetching transfers from block ${startBlock} → ${endBlock}...`);

  const transfers = await basescanGet({
    module: "account",
    action: "tokentx",
    contractaddress: tokenAddress,
    startblock: startBlock,
    endblock: endBlock || "99999999",
    sort: "asc",
    offset: "500",
  });

  if (!transfers?.length) {
    // Fallback: get first 200 transfers ever
    console.log("[WalletIntel] No early transfers found with block range, trying full history...");
    const allTx = await basescanGet({
      module: "account",
      action: "tokentx",
      contractaddress: tokenAddress,
      sort: "asc",
      offset: "200",
    });
    if (!allTx?.length) return { error: "No transfer history found. You may need a Basescan API key for this token.", tokenInfo };
    transfers.push(...allTx);
  }

  // Build buyer map
  const buyerMap = new Map();
  for (const tx of transfers) {
    const to = tx.to?.toLowerCase();
    if (!to || isKnownContract(to) || isKnownStablecoin(to)) continue;
    const ts = parseInt(tx.timeStamp) * 1000;
    if (!buyerMap.has(to)) {
      buyerMap.set(to, { address: to, firstBuyTs: ts, txHash: tx.hash, txCount: 0 });
    }
    const b = buyerMap.get(to);
    b.txCount++;
    if (ts < b.firstBuyTs) { b.firstBuyTs = ts; b.txHash = tx.hash; }
  }

  const buyers = [...buyerMap.values()]
    .sort((a, b) => a.firstBuyTs - b.firstBuyTs)
    .slice(0, TOP_EARLY_BUYERS);

  console.log(`[WalletIntel] Found ${buyers.length} early buyers to analyze`);

  const launchPrice = await getTokenPriceAtTime(tokenAddress, pairCreatedAt);
  const multiplierSinceLaunch = launchPrice > 0 ? currentPrice / launchPrice : 0;

  return { tokenAddress, tokenInfo, symbol, pairCreatedAt, currentPrice, currentMcap, launchPrice, multiplierSinceLaunch, earlyBuyers: buyers };
}

// ── Step 2: Wallet history ────────────────────────────────────────────────
async function analyzeWalletHistory(walletAddress) {
  const txs = await basescanGet({
    module: "account",
    action: "tokentx",
    address: walletAddress,
    sort: "asc",
    offset: "500",
  });
  if (!txs?.length) return null;

  const tokenMap = new Map();
  for (const tx of txs) {
    const tokenAddr = tx.contractAddress?.toLowerCase();
    if (!tokenAddr || isKnownStablecoin(tokenAddr) || isKnownContract(tokenAddr)) continue;
    const isReceiving = tx.to?.toLowerCase() === walletAddress.toLowerCase();
    if (!isReceiving) continue;
    const ts = parseInt(tx.timeStamp) * 1000;
    if (!tokenMap.has(tokenAddr)) {
      tokenMap.set(tokenAddr, { address: tokenAddr, symbol: tx.tokenSymbol, name: tx.tokenName, firstBuyTs: ts, txHash: tx.hash });
    } else if (ts < tokenMap.get(tokenAddr).firstBuyTs) {
      const t = tokenMap.get(tokenAddr);
      t.firstBuyTs = ts; t.txHash = tx.hash;
    }
  }

  const tokens = [...tokenMap.values()];
  const results = [];

  for (const token of tokens.slice(0, 25)) {
    const info = await getTokenInfo(token.address);
    if (!info) continue;
    const currentPrice = parseFloat(info.priceUsd || 0);
    if (!currentPrice) continue;
    const buyPrice = await getTokenPriceAtTime(token.address, token.firstBuyTs);
    const multiplier = buyPrice > 0 ? currentPrice / buyPrice : 0;
    const pairCreatedAt = info.pairCreatedAt || token.firstBuyTs;
    const hoursAfterLaunch = Math.max(0, (token.firstBuyTs - pairCreatedAt) / 3600000);
    results.push({
      ...token, currentPrice, buyPrice, multiplier,
      hoursAfterLaunch,
      isWin: multiplier >= MIN_WIN_MULTIPLIER,
      is10x: multiplier >= 10,
      is100x: multiplier >= 100,
      currentMcap: info.fdv || 0,
    });
    await sleep(150);
  }

  return { address: walletAddress, tokens: results };
}

// ── Step 3: Score ─────────────────────────────────────────────────────────
function scoreWallet(walletHistory) {
  const { address, tokens } = walletHistory;
  if (!tokens?.length || tokens.length < MIN_TRADES_TO_SCORE) {
    return { address, score: 0, grade: "F", reason: "Insufficient data", totalTrades: tokens?.length || 0, wins: 0, tenXHits: 0, hundredXHits: 0, winRate: "0%", avgMultiplier: "1x", avgHoursAfterLaunch: "?", avgLeadTimeHours: "N/A", earlyBuyRate: "0%", topTrades: [], isKOL: false, tokens: tokens || [] };
  }

  const wins = tokens.filter(t => t.isWin);
  const tenX = tokens.filter(t => t.is10x);
  const hundredX = tokens.filter(t => t.is100x);
  const winRate = wins.length / tokens.length;
  const avgMultiplier = tokens.reduce((s, t) => s + (t.multiplier || 1), 0) / tokens.length;
  const avgHoursAfterLaunch = tokens.reduce((s, t) => s + (t.hoursAfterLaunch || 0), 0) / tokens.length;
  const earlyBuys = tokens.filter(t => t.hoursAfterLaunch < 2).length;

  let score = 0;
  score += Math.min(30, winRate * 60);
  score += Math.min(25, Math.log10(Math.max(1, avgMultiplier)) * 12);
  score += Math.min(20, tenX.length * 4);
  score += Math.min(15, hundredX.length * 7);
  score += Math.min(10, (earlyBuys / tokens.length) * 20);
  score = Math.round(Math.min(100, score));

  const grade = score >= 85 ? "S" : score >= 70 ? "A" : score >= 55 ? "B" : score >= 40 ? "C" : "D";
  const mooners = tokens.filter(t => t.isWin && t.hoursAfterLaunch < 24);
  const avgLeadTimeHours = mooners.length
    ? (mooners.reduce((s, t) => s + t.hoursAfterLaunch, 0) / mooners.length).toFixed(1)
    : "N/A";

  return {
    address, score, grade,
    winRate: (winRate * 100).toFixed(0) + "%",
    totalTrades: tokens.length,
    wins: wins.length,
    tenXHits: tenX.length,
    hundredXHits: hundredX.length,
    avgMultiplier: avgMultiplier.toFixed(1) + "x",
    avgHoursAfterLaunch: avgHoursAfterLaunch.toFixed(1),
    avgLeadTimeHours,
    earlyBuyRate: ((earlyBuys / tokens.length) * 100).toFixed(0) + "%",
    topTrades: tokens.filter(t => t.multiplier > 1).sort((a, b) => b.multiplier - a.multiplier).slice(0, 5),
    isKOL: score >= 70,
    tokens,
  };
}

// ── Main pipeline ─────────────────────────────────────────────────────────
async function investigateToken(tokenAddress) {
  console.log(`\n${"=".repeat(55)}`);
  console.log(`[WalletIntel] Investigating: ${tokenAddress}`);

  const earlyData = await findEarlyBuyers(tokenAddress);
  if (earlyData.error) return earlyData;

  console.log(`[WalletIntel] ${earlyData.symbol} is ${earlyData.multiplierSinceLaunch.toFixed(1)}x from launch`);
  console.log(`[WalletIntel] Scoring ${earlyData.earlyBuyers.length} wallets...\n`);

  const walletScores = [];
  for (const buyer of earlyData.earlyBuyers) {
    try {
      const history = await analyzeWalletHistory(buyer.address);
      if (!history) continue;
      const scored = scoreWallet(history);
      walletScores.push({
        ...scored,
        firstBuyTs: buyer.firstBuyTs,
        firstBuyTxHash: buyer.txHash,
        hoursAfterTokenLaunch: Math.max(0, (buyer.firstBuyTs - earlyData.pairCreatedAt) / 3600000).toFixed(1),
      });
      console.log(`  ${scored.address.slice(0,10)}... ${scored.grade}(${scored.score}) WR:${scored.winRate} ${scored.wins}/${scored.totalTrades} 10x:${scored.tenXHits} KOL:${scored.isKOL ? "✅" : "❌"}`);
    } catch (e) {
      console.error(`  Wallet ${buyer.address.slice(0,10)} failed:`, e.message);
    }
    await sleep(300);
  }

  walletScores.sort((a, b) => b.score - a.score);
  const kols = walletScores.filter(w => w.isKOL);
  console.log(`\n[WalletIntel] 🏆 ${kols.length} KOL wallets found`);

  return {
    tokenAddress,
    symbol: earlyData.symbol,
    tokenInfo: earlyData.tokenInfo,
    multiplierSinceLaunch: earlyData.multiplierSinceLaunch,
    pairCreatedAt: earlyData.pairCreatedAt,
    wallets: walletScores,
    kols,
    analyzedAt: Date.now(),
  };
}

// ── Live monitor ──────────────────────────────────────────────────────────
const walletAlerts = [];

async function startWalletMonitor(walletAddresses, alertCallback) {
  console.log(`[WalletMonitor] Tracking ${walletAddresses.length} wallets...`);
  const lastTxMap = new Map();

  // Seed last known tx per wallet
  for (const addr of walletAddresses) {
    const txs = await basescanGet({ module: "account", action: "tokentx", address: addr, sort: "desc", offset: "1" });
    if (txs?.length) lastTxMap.set(addr.toLowerCase(), txs[0].hash);
    await sleep(200);
  }

  // Return interval handle (synchronously)
  const interval = setInterval(async () => {
    for (const addr of walletAddresses) {
      const key = addr.toLowerCase();
      try {
        const txs = await basescanGet({ module: "account", action: "tokentx", address: addr, sort: "desc", offset: "5" });
        if (!txs?.length) continue;
        const lastHash = lastTxMap.get(key);
        const newTxs = lastHash ? txs.filter(tx => tx.hash !== lastHash && parseInt(tx.timeStamp) * 1000 > Date.now() - 120000) : [];
        if (!newTxs.length) continue;
        lastTxMap.set(key, txs[0].hash);
        const buys = newTxs.filter(tx => tx.to?.toLowerCase() === key && !isKnownStablecoin(tx.contractAddress) && !isKnownContract(tx.to));
        for (const buy of buys) {
          const alert = { wallet: addr, walletGrade: "?", tokenAddress: buy.contractAddress, tokenSymbol: buy.tokenSymbol, tokenName: buy.tokenName, txHash: buy.hash, ts: parseInt(buy.timeStamp) * 1000 };
          console.log(`\n🚨 WALLET ALERT: ${addr.slice(0,10)}... bought $${buy.tokenSymbol}`);
          walletAlerts.unshift(alert);
          if (walletAlerts.length > 100) walletAlerts.pop();
          if (alertCallback) alertCallback(alert);
        }
      } catch (e) { /* silent */ }
      await sleep(200);
    }
  }, 30000);

  return interval;
}

// ── Helpers ───────────────────────────────────────────────────────────────
const KNOWN_CONTRACTS = new Set([
  "0x4200000000000000000000000000000000000006",
  "0x2626664c2603336e57b271c5c0b26f421741e481",
  "0x33128a8fc17869897dce68ed026d694621f6fdfd",
  "0x000000000000000000000000000000000000dead",
]);
const KNOWN_STABLECOINS = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
]);
function isKnownContract(addr) { return KNOWN_CONTRACTS.has(addr?.toLowerCase()); }
function isKnownStablecoin(addr) { return KNOWN_STABLECOINS.has(addr?.toLowerCase()); }

async function getBlockAtTime(timestamp) {
  try {
    const res = await basescanGet({ module: "block", action: "getblocknobytime", timestamp: String(timestamp), closest: "before" });
    return res || "0";
  } catch { return "0"; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { investigateToken, analyzeWalletHistory, scoreWallet, startWalletMonitor, walletAlerts };
