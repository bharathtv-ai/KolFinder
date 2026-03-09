const axios = require("axios");

const EARLY_BUYER_WINDOW_HOURS = 6;
const MIN_WIN_MULTIPLIER = 5;
const MIN_TRADES_TO_SCORE = 2;
const TOP_EARLY_BUYERS = 15;

// ── In-memory cache to avoid repeat API calls ─────────────────────────────
const tokenCache = new Map();
const priceCache = new Map();

// ── Blockscout (free, no key, Base chain) ─────────────────────────────────
async function blockscoutGet(params) {
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await axios.get(`https://base.blockscout.com/api?${qs}`, {
      timeout: 20000, headers: { Accept: "application/json" }
    });
    if (res.data?.status === "1") return res.data.result;
    console.log("[Blockscout]", res.data?.message || "no result");
    return [];
  } catch (e) {
    console.error("[Blockscout]", e.message);
    return [];
  }
}

// ── DexScreener batch lookup (up to 30 tokens per call) ───────────────────
// Correct endpoint: /tokens/v1/{chainId}/{comma-separated-addresses}
async function batchFetchTokenInfo(addresses) {
  const uncached = addresses.filter(a => !tokenCache.has(a.toLowerCase()));
  if (!uncached.length) return;

  // Chunk into groups of 30 (API limit)
  for (let i = 0; i < uncached.length; i += 30) {
    const chunk = uncached.slice(i, i + 30).map(a => a.toLowerCase());
    try {
      const url = `https://api.dexscreener.com/tokens/v1/base/${chunk.join(",")}`;
      const res = await axios.get(url, {
        timeout: 15000, headers: { Accept: "application/json" }
      });
      const pairs = Array.isArray(res.data) ? res.data : [];
      // Map each pair back to its token address
      for (const pair of pairs) {
        const addr = pair.baseToken?.address?.toLowerCase();
        if (!addr) continue;
        if (!tokenCache.has(addr) || (pair.liquidity?.usd || 0) > (tokenCache.get(addr)?.liquidity?.usd || 0)) {
          tokenCache.set(addr, pair);
        }
      }
      console.log(`[DexScreener] Fetched ${pairs.length} pairs for ${chunk.length} tokens`);
    } catch (e) {
      console.log(`[DexScreener batch] ${e.message} — trying GeckoTerminal fallback`);
      // GeckoTerminal for individual tokens on failure
      for (const addr of chunk) {
        if (tokenCache.has(addr)) continue;
        try {
          const res = await axios.get(
            `https://api.geckoterminal.com/api/v2/networks/base/tokens/${addr}`,
            { timeout: 10000 }
          );
          const d = res.data?.data?.attributes;
          if (d) {
            tokenCache.set(addr, {
              chainId: "base",
              baseToken: { address: addr, symbol: d.symbol, name: d.name },
              priceUsd: d.price_usd || "0",
              fdv: d.fdv_usd || 0,
              pairCreatedAt: null,
              liquidity: { usd: parseFloat(d.total_reserve_in_usd || 0) },
            });
          }
        } catch {}
        await sleep(200);
      }
    }
    if (i + 30 < uncached.length) await sleep(1000); // 1s between batches
  }
}

function getTokenFromCache(address) {
  return tokenCache.get(address.toLowerCase()) || null;
}

// ── Single token lookup (with cache) ─────────────────────────────────────
async function getTokenInfo(tokenAddress) {
  const addr = tokenAddress.toLowerCase();
  if (tokenCache.has(addr)) return tokenCache.get(addr);
  await batchFetchTokenInfo([addr]);
  if (tokenCache.has(addr)) return tokenCache.get(addr);

  // Blockscout last resort
  const txs = await blockscoutGet({
    module: "account", action: "tokentx",
    contractaddress: addr, sort: "asc", offset: "1"
  });
  if (txs?.length) {
    const info = {
      chainId: "base",
      baseToken: { address: addr, symbol: txs[0].tokenSymbol, name: txs[0].tokenName },
      priceUsd: "0", fdv: 0,
      pairCreatedAt: parseInt(txs[0].timeStamp) * 1000,
      liquidity: { usd: 0 }, pairAddress: addr,
    };
    tokenCache.set(addr, info);
    return info;
  }
  return null;
}

// ── GeckoTerminal OHLCV price at time (cached) ────────────────────────────
async function getTokenPriceAtTime(tokenAddress, timestampMs) {
  const cacheKey = `${tokenAddress.toLowerCase()}_${Math.floor(timestampMs / 3600000)}`;
  if (priceCache.has(cacheKey)) return priceCache.get(cacheKey);
  try {
    const res = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress.toLowerCase()}/ohlcv/hour?limit=168`,
      { timeout: 10000 }
    );
    const candles = res.data?.data?.attributes?.ohlcv_list || [];
    if (!candles.length) { priceCache.set(cacheKey, 0); return 0; }
    const ts = timestampMs / 1000;
    const price = candles.reduce((best, c) =>
      Math.abs(c[0] - ts) < Math.abs(best[0] - ts) ? c : best, candles[0]
    )[4] || 0;
    priceCache.set(cacheKey, price);
    return price;
  } catch { priceCache.set(cacheKey, 0); return 0; }
}

async function getBlockAtTime(timestamp) {
  try {
    const res = await blockscoutGet({
      module: "block", action: "getblocknobytime",
      timestamp: String(timestamp), closest: "before"
    });
    return res || "0";
  } catch { return "0"; }
}

// ── Step 1: Find early buyers ─────────────────────────────────────────────
async function findEarlyBuyers(tokenAddress) {
  console.log(`[WalletIntel] Looking up token ${tokenAddress}...`);
  const tokenInfo = await getTokenInfo(tokenAddress);
  if (!tokenInfo) return { error: "Token not found on Base." };

  const pairCreatedAt = tokenInfo.pairCreatedAt || (Date.now() - 86400000);
  const currentPrice = parseFloat(tokenInfo.priceUsd || 0);
  const symbol = tokenInfo.baseToken?.symbol || "???";
  console.log(`[WalletIntel] Found: ${symbol} | $${currentPrice}`);

  const launchTs = Math.floor(pairCreatedAt / 1000);
  const endTs = Math.floor((pairCreatedAt + EARLY_BUYER_WINDOW_HOURS * 3600 * 1000) / 1000);
  const startBlock = await getBlockAtTime(launchTs);
  const endBlock = await getBlockAtTime(endTs);

  let transfers = await blockscoutGet({
    module: "account", action: "tokentx", contractaddress: tokenAddress,
    startblock: startBlock, endblock: endBlock || "99999999", sort: "asc", offset: "500"
  });

  if (!transfers?.length) {
    transfers = await blockscoutGet({
      module: "account", action: "tokentx",
      contractaddress: tokenAddress, sort: "asc", offset: "200"
    });
  }

  if (!transfers?.length) return { error: "No transfer history found on Blockscout.", tokenInfo };

  const SKIP = new Set([
    "0x4200000000000000000000000000000000000006",
    "0x2626664c2603336e57b271c5c0b26f421741e481",
    "0x33128a8fc17869897dce68ed026d694621f6fdfd",
    "0x000000000000000000000000000000000000dead",
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
  ]);

  const buyerMap = new Map();
  for (const tx of transfers) {
    const to = tx.to?.toLowerCase();
    if (!to || SKIP.has(to)) continue;
    const ts = parseInt(tx.timeStamp) * 1000;
    if (!buyerMap.has(to)) buyerMap.set(to, { address: to, firstBuyTs: ts, txHash: tx.hash });
    else if (ts < buyerMap.get(to).firstBuyTs) {
      buyerMap.get(to).firstBuyTs = ts;
      buyerMap.get(to).txHash = tx.hash;
    }
  }

  const buyers = [...buyerMap.values()]
    .sort((a, b) => a.firstBuyTs - b.firstBuyTs)
    .slice(0, TOP_EARLY_BUYERS);

  console.log(`[WalletIntel] ${buyers.length} early buyers found`);

  const launchPrice = await getTokenPriceAtTime(tokenAddress, pairCreatedAt);
  const multiplierSinceLaunch = launchPrice > 0 ? currentPrice / launchPrice : 0;

  return { tokenAddress, tokenInfo, symbol, pairCreatedAt, currentPrice, currentMcap: tokenInfo.fdv || 0, launchPrice, multiplierSinceLaunch, earlyBuyers: buyers };
}

// ── Step 2: Wallet history with BATCH token lookup ────────────────────────
async function analyzeWalletHistory(walletAddress) {
  const txs = await blockscoutGet({
    module: "account", action: "tokentx",
    address: walletAddress, sort: "asc", offset: "500"
  });
  if (!txs?.length) return null;

  const SKIP = new Set([
    "0x4200000000000000000000000000000000000006",
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
  ]);

  // Build token map first
  const tokenMap = new Map();
  for (const tx of txs) {
    const addr = tx.contractAddress?.toLowerCase();
    if (!addr || SKIP.has(addr) || tx.to?.toLowerCase() !== walletAddress.toLowerCase()) continue;
    const ts = parseInt(tx.timeStamp) * 1000;
    if (!tokenMap.has(addr)) tokenMap.set(addr, { address: addr, symbol: tx.tokenSymbol, name: tx.tokenName, firstBuyTs: ts, txHash: tx.hash });
    else if (ts < tokenMap.get(addr).firstBuyTs) {
      tokenMap.get(addr).firstBuyTs = ts;
      tokenMap.get(addr).txHash = tx.hash;
    }
  }

  const tokenAddrs = [...tokenMap.keys()].slice(0, 30);
  if (!tokenAddrs.length) return null;

  // BATCH fetch all token info in 1-2 API calls instead of 30 individual calls
  console.log(`[WalletIntel] Batch fetching ${tokenAddrs.length} tokens for ${walletAddress.slice(0,10)}...`);
  await batchFetchTokenInfo(tokenAddrs);

  // Now score each token using cached data
  const results = [];
  for (const addr of tokenAddrs) {
    const token = tokenMap.get(addr);
    const info = getTokenFromCache(addr);
    if (!info) continue;
    const currentPrice = parseFloat(info.priceUsd || 0);
    if (!currentPrice) continue;
    const buyPrice = await getTokenPriceAtTime(addr, token.firstBuyTs);
    const multiplier = buyPrice > 0 ? currentPrice / buyPrice : 0;
    const pairCreatedAt = info.pairCreatedAt || token.firstBuyTs;
    results.push({
      ...token, currentPrice, buyPrice, multiplier,
      hoursAfterLaunch: Math.max(0, (token.firstBuyTs - pairCreatedAt) / 3600000),
      isWin: multiplier >= MIN_WIN_MULTIPLIER,
      is10x: multiplier >= 10, is100x: multiplier >= 100,
      currentMcap: info.fdv || 0,
    });
    await sleep(100);
  }

  return { address: walletAddress, tokens: results };
}

// ── Step 3: Score ─────────────────────────────────────────────────────────
function scoreWallet(walletHistory) {
  const { address, tokens } = walletHistory;
  const empty = { address, score: 0, grade: "F", totalTrades: tokens?.length || 0, wins: 0, tenXHits: 0, hundredXHits: 0, winRate: "0%", avgMultiplier: "1x", avgHoursAfterLaunch: "?", avgLeadTimeHours: "N/A", earlyBuyRate: "0%", topTrades: [], isKOL: false, tokens: tokens || [] };
  if (!tokens?.length || tokens.length < MIN_TRADES_TO_SCORE) return empty;

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
    totalTrades: tokens.length, wins: wins.length,
    tenXHits: tenX.length, hundredXHits: hundredX.length,
    avgMultiplier: avgMultiplier.toFixed(1) + "x",
    avgHoursAfterLaunch: avgHoursAfterLaunch.toFixed(1),
    avgLeadTimeHours, earlyBuyRate: ((earlyBuys / tokens.length) * 100).toFixed(0) + "%",
    topTrades: tokens.filter(t => t.multiplier > 1).sort((a, b) => b.multiplier - a.multiplier).slice(0, 5),
    isKOL: score >= 70, tokens,
  };
}

// ── Main pipeline ─────────────────────────────────────────────────────────
async function investigateToken(tokenAddress) {
  console.log(`\n${"=".repeat(55)}\n[WalletIntel] Investigating: ${tokenAddress}`);
  const earlyData = await findEarlyBuyers(tokenAddress);
  if (earlyData.error) return earlyData;

  console.log(`[WalletIntel] Scoring ${earlyData.earlyBuyers.length} wallets...`);
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
      console.log(`  ${scored.address.slice(0, 10)}... ${scored.grade}(${scored.score}) WR:${scored.winRate} 10x:${scored.tenXHits} KOL:${scored.isKOL ? "✅" : "❌"}`);
    } catch (e) {
      console.error(`  Wallet error:`, e.message);
    }
    await sleep(500); // Respectful delay between wallets
  }

  walletScores.sort((a, b) => b.score - a.score);
  const kols = walletScores.filter(w => w.isKOL);
  console.log(`[WalletIntel] 🏆 ${kols.length} KOL wallets found`);

  return {
    tokenAddress, symbol: earlyData.symbol, tokenInfo: earlyData.tokenInfo,
    multiplierSinceLaunch: earlyData.multiplierSinceLaunch,
    pairCreatedAt: earlyData.pairCreatedAt,
    wallets: walletScores, kols, analyzedAt: Date.now(),
  };
}

// ── Live monitor ──────────────────────────────────────────────────────────
const walletAlerts = [];

async function startWalletMonitor(walletAddresses, alertCallback) {
  console.log(`[WalletMonitor] Tracking ${walletAddresses.length} wallets...`);
  const lastTxMap = new Map();
  for (const addr of walletAddresses) {
    const txs = await blockscoutGet({ module: "account", action: "tokentx", address: addr, sort: "desc", offset: "1" });
    if (txs?.length) lastTxMap.set(addr.toLowerCase(), txs[0].hash);
    await sleep(300);
  }
  return setInterval(async () => {
    for (const addr of walletAddresses) {
      const key = addr.toLowerCase();
      try {
        const txs = await blockscoutGet({ module: "account", action: "tokentx", address: addr, sort: "desc", offset: "5" });
        if (!txs?.length) continue;
        const lastHash = lastTxMap.get(key);
        const SKIP = new Set(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0x50c5725949a6f0c72e6c4a641f24049a917db0cb"]);
        const newTxs = lastHash ? txs.filter(tx => tx.hash !== lastHash && parseInt(tx.timeStamp) * 1000 > Date.now() - 120000) : [];
        if (!newTxs.length) continue;
        lastTxMap.set(key, txs[0].hash);
        for (const buy of newTxs.filter(tx => tx.to?.toLowerCase() === key && !SKIP.has(tx.contractAddress?.toLowerCase()))) {
          const alert = { wallet: addr, walletGrade: "?", tokenAddress: buy.contractAddress, tokenSymbol: buy.tokenSymbol, tokenName: buy.tokenName, txHash: buy.hash, ts: parseInt(buy.timeStamp) * 1000 };
          console.log(`🚨 ${addr.slice(0, 10)}... bought $${buy.tokenSymbol}`);
          walletAlerts.unshift(alert);
          if (walletAlerts.length > 100) walletAlerts.pop();
          if (alertCallback) alertCallback(alert);
        }
      } catch {}
      await sleep(300);
    }
  }, 30000);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { investigateToken, analyzeWalletHistory, scoreWallet, startWalletMonitor, walletAlerts };
