const axios = require("axios");

const MORALIS_KEY = process.env.MORALIS_API_KEY || "";
const CHAIN = "base";

// ── Moralis API client ────────────────────────────────────────────────────
const moralis = axios.create({
  baseURL: "https://deep-index.moralis.io/api/v2.2",
  headers: { "X-API-Key": MORALIS_KEY, Accept: "application/json" },
  timeout: 20000,
});

// ── Cache ─────────────────────────────────────────────────────────────────
const tokenInfoCache = new Map();
const ethPriceCache = { price: 3500, ts: 0 };

// ── ETH price fallback ────────────────────────────────────────────────────
async function getEthPrice() {
  if (Date.now() - ethPriceCache.ts < 60000) return ethPriceCache.price;
  try {
    const r = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { timeout: 5000 }
    );
    ethPriceCache.price = r.data?.ethereum?.usd || ethPriceCache.price;
    ethPriceCache.ts = Date.now();
  } catch {}
  return ethPriceCache.price;
}

// ── Token info ────────────────────────────────────────────────────────────
async function getTokenInfo(tokenAddress) {
  const addr = tokenAddress.toLowerCase();
  if (tokenInfoCache.has(addr)) return tokenInfoCache.get(addr);
  try {
    const r = await moralis.get(`/erc20/${addr}/price`, {
      params: { chain: CHAIN, include: "percent_change" }
    });
    const info = {
      address: addr,
      name: r.data.tokenName,
      symbol: r.data.tokenSymbol,
      logo: r.data.tokenLogo,
      usdPrice: r.data.usdPrice || 0,
      usdPrice24hrChange: r.data["24hrPercentChange"] || 0,
      pairAddress: r.data.pairAddress,
      pairLiquidityUsd: r.data.pairTotalLiquidityUsd || 0,
      exchangeName: r.data.exchangeName,
      securityScore: r.data.securityScore,
      possibleSpam: r.data.possibleSpam,
    };
    tokenInfoCache.set(addr, info);
    return info;
  } catch (e) {
    console.log("[Moralis] getTokenInfo error:", e.response?.data?.message || e.message);
    return null;
  }
}

// ── Fetch ALL swaps for a token (paginated) ───────────────────────────────
async function fetchAllSwaps(tokenAddress, maxPages = 20) {
  const addr = tokenAddress.toLowerCase();
  const swaps = [];
  let cursor = null;
  let page = 0;

  console.log(`[Engine] Fetching swaps for ${addr}...`);

  while (page < maxPages) {
    try {
      const params = { chain: CHAIN, limit: 100 };
      if (cursor) params.cursor = cursor;

      const r = await moralis.get(`/erc20/${addr}/swaps`, { params });
      const results = r.data.result || [];
      swaps.push(...results);

      console.log(`[Engine] Page ${page + 1}: ${results.length} swaps (total: ${swaps.length})`);

      // Stop if no more pages
      if (!r.data.cursor || results.length < 100) break;
      cursor = r.data.cursor;
      page++;
      await sleep(200); // be nice to API
    } catch (e) {
      console.log("[Engine] fetchAllSwaps error:", e.response?.data?.message || e.message);
      break;
    }
  }

  console.log(`[Engine] Total swaps fetched: ${swaps.length}`);
  return swaps;
}

// ── Reconstruct per-wallet PnL from swaps ────────────────────────────────
function buildWalletPnL(swaps, tokenAddress, currentPriceUsd) {
  const addr = tokenAddress.toLowerCase();
  const walletMap = new Map();

  for (const swap of swaps) {
    const wallet = swap.walletAddress?.toLowerCase();
    if (!wallet) continue;

    const ts = new Date(swap.blockTimestamp).getTime();
    const isBuy = swap.transactionType === "buy";
    const isSell = swap.transactionType === "sell";

    if (!isBuy && !isSell) continue;

    if (!walletMap.has(wallet)) {
      walletMap.set(wallet, {
        address: wallet,
        label: swap.walletAddressLabel || null,
        buyUsd: 0,        // total USD spent buying
        sellUsd: 0,       // total USD received selling
        tokensBought: 0,  // total tokens acquired
        tokensSold: 0,    // total tokens sold
        buyCount: 0,
        sellCount: 0,
        firstBuyTs: null,
        lastActivityTs: null,
        firstBuyTxHash: null,
        buyEvents: [],
        sellEvents: [],
        subCategories: new Set(),
      });
    }

    const w = walletMap.get(wallet);

    if (isBuy) {
      // bought.usdAmount = what they paid (sold.usdAmount is negative)
      const usdSpent = Math.abs(swap.sold?.usdAmount || 0) || swap.totalValueUsd || 0;
      const tokensReceived = parseFloat(swap.bought?.amount || 0);

      w.buyUsd += usdSpent;
      w.tokensBought += tokensReceived;
      w.buyCount++;
      w.buyEvents.push({
        ts,
        usdSpent: parseFloat(usdSpent.toFixed(4)),
        tokensReceived: parseFloat(tokensReceived.toFixed(4)),
        txHash: swap.transactionHash,
        subCategory: swap.subCategory,
        pairLabel: swap.pairLabel,
      });

      if (!w.firstBuyTs || ts < w.firstBuyTs) {
        w.firstBuyTs = ts;
        w.firstBuyTxHash = swap.transactionHash;
      }
    }

    if (isSell) {
      const usdReceived = Math.abs(swap.bought?.usdAmount || 0) || swap.totalValueUsd || 0;
      const tokensSold = Math.abs(parseFloat(swap.sold?.amount || 0));

      w.sellUsd += usdReceived;
      w.tokensSold += tokensSold;
      w.sellCount++;
      w.sellEvents.push({
        ts,
        usdReceived: parseFloat(usdReceived.toFixed(4)),
        tokensSold: parseFloat(tokensSold.toFixed(4)),
        txHash: swap.transactionHash,
        subCategory: swap.subCategory,
        pairLabel: swap.pairLabel,
      });
    }

    if (swap.subCategory) w.subCategories.add(swap.subCategory);
    if (!w.lastActivityTs || ts > w.lastActivityTs) w.lastActivityTs = ts;
  }

  // Calculate final PnL for each wallet
  const results = [];
  for (const [, w] of walletMap) {
    if (w.buyCount === 0) continue;

    const moonBagTokens = Math.max(0, w.tokensBought - w.tokensSold);
    const moonBagUsd = moonBagTokens * currentPriceUsd;
    const realizedPnlUsd = w.sellUsd - w.buyUsd;
    const totalPnlUsd = realizedPnlUsd + moonBagUsd;
    const roi = w.buyUsd > 0 ? (totalPnlUsd / w.buyUsd) * 100 : 0;

    // Determine status
    let status = "holding";
    if (w.subCategories.has("sellAll") || moonBagTokens < w.tokensBought * 0.05) status = "exited";
    else if (w.tokensSold > 0) status = "partial";

    // Avg entry price
    const avgEntryUsd = w.tokensBought > 0 ? w.buyUsd / w.tokensBought : 0;
    const currentMultiplier = avgEntryUsd > 0 ? currentPriceUsd / avgEntryUsd : 0;

    results.push({
      address: w.address,
      label: w.label,
      // PnL
      buyUsd: parseFloat(w.buyUsd.toFixed(2)),
      sellUsd: parseFloat(w.sellUsd.toFixed(2)),
      realizedPnlUsd: parseFloat(realizedPnlUsd.toFixed(2)),
      moonBagTokens: parseFloat(moonBagTokens.toFixed(4)),
      moonBagUsd: parseFloat(moonBagUsd.toFixed(2)),
      totalPnlUsd: parseFloat(totalPnlUsd.toFixed(2)),
      roi: parseFloat(roi.toFixed(1)),
      // Trade stats
      buyCount: w.buyCount,
      sellCount: w.sellCount,
      tokensBought: parseFloat(w.tokensBought.toFixed(4)),
      tokensSold: parseFloat(w.tokensSold.toFixed(4)),
      avgEntryUsd: parseFloat(avgEntryUsd.toFixed(6)),
      currentMultiplier: parseFloat(currentMultiplier.toFixed(2)),
      status,
      // Timestamps
      firstBuyTs: w.firstBuyTs,
      firstBuyTxHash: w.firstBuyTxHash,
      lastActivityTs: w.lastActivityTs,
      // Events
      buyEvents: w.buyEvents.sort((a, b) => a.ts - b.ts),
      sellEvents: w.sellEvents.sort((a, b) => a.ts - b.ts),
    });
  }

  // Sort by total PnL descending
  results.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
  return results;
}

// ── Cabal detection ───────────────────────────────────────────────────────
function detectCabals(wallets) {
  const WINDOW_MS = 30 * 60 * 1000; // 30 minutes
  const MIN_CO_BUYS = 2;

  const coBuyPairs = new Map();

  for (let i = 0; i < wallets.length; i++) {
    for (let j = i + 1; j < wallets.length; j++) {
      const a = wallets[i];
      const b = wallets[j];
      let coBuys = 0;
      for (const ba of a.buyEvents) {
        for (const bb of b.buyEvents) {
          if (Math.abs(ba.ts - bb.ts) < WINDOW_MS) { coBuys++; break; }
        }
      }
      if (coBuys >= MIN_CO_BUYS) {
        coBuyPairs.set(`${a.address}|${b.address}`, coBuys);
      }
    }
  }

  // Union-find grouping
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  }
  function union(x, y) { parent.set(find(x), find(y)); }

  for (const key of coBuyPairs.keys()) {
    const [a, b] = key.split("|");
    union(a, b);
  }

  const groups = new Map();
  for (const key of coBuyPairs.keys()) {
    const [a, b] = key.split("|");
    const root = find(a);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root).add(a);
    groups.get(root).add(b);
  }

  const cabals = [];
  for (const [, members] of groups) {
    if (members.size < 2) continue;
    const memberWallets = wallets.filter(w => members.has(w.address));
    const totalPnlUsd = memberWallets.reduce((s, w) => s + w.totalPnlUsd, 0);
    const caller = [...memberWallets].sort((a, b) => (a.firstBuyTs || 0) - (b.firstBuyTs || 0))[0];

    cabals.push({
      members: [...members],
      memberCount: members.size,
      totalPnlUsd: parseFloat(totalPnlUsd.toFixed(2)),
      callerAddress: caller?.address,
      callerPnl: caller?.totalPnlUsd,
      avgBuyTs: memberWallets.reduce((s, w) => s + (w.firstBuyTs || 0), 0) / memberWallets.length,
      memberDetails: memberWallets.map(w => ({
        address: w.address,
        pnl: w.totalPnlUsd,
        status: w.status,
        firstBuyTs: w.firstBuyTs,
        roi: w.roi,
      })),
    });
  }

  cabals.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
  console.log(`[Engine] ${cabals.length} cabals detected`);
  return cabals;
}

// ── Main: investigate token ───────────────────────────────────────────────
async function reconstructTokenTrades(tokenAddress) {
  console.log(`\n${"=".repeat(55)}\n[Engine] Investigating: ${tokenAddress}`);

  // 1. Get token info + current price
  const tokenInfo = await getTokenInfo(tokenAddress);
  if (!tokenInfo) return { error: "Token not found on Moralis. Check the address is on Base." };

  console.log(`[Engine] ${tokenInfo.symbol} | $${tokenInfo.usdPrice}`);

  // 2. Fetch all swaps
  const swaps = await fetchAllSwaps(tokenAddress);
  if (!swaps.length) return { error: "No swap history found for this token.", tokenInfo };

  // 3. Build wallet PnL map
  const wallets = buildWalletPnL(swaps, tokenAddress, tokenInfo.usdPrice);
  console.log(`[Engine] ${wallets.length} unique wallets`);

  // 4. Detect cabals
  const cabals = detectCabals(wallets);

  // 5. Stats
  const profitable = wallets.filter(w => w.totalPnlUsd > 0);
  const stillHolding = wallets.filter(w => w.status === "holding");
  const totalVolumeUsd = swaps.reduce((s, sw) => s + (sw.totalValueUsd || 0), 0);

  return {
    tokenAddress: tokenAddress.toLowerCase(),
    symbol: tokenInfo.symbol,
    name: tokenInfo.name,
    logo: tokenInfo.logo,
    currentPriceUsd: tokenInfo.usdPrice,
    usdPrice24hrChange: tokenInfo.usdPrice24hrChange,
    pairLiquidityUsd: tokenInfo.pairLiquidityUsd,
    exchangeName: tokenInfo.exchangeName,
    securityScore: tokenInfo.securityScore,
    totalSwaps: swaps.length,
    totalVolumeUsd: parseFloat(totalVolumeUsd.toFixed(2)),
    wallets,
    cabals,
    totalWallets: wallets.length,
    profitableWallets: profitable.length,
    holdingWallets: stillHolding.length,
    analyzedAt: Date.now(),
  };
}

// ── Wallet full history ───────────────────────────────────────────────────
async function getWalletFullHistory(walletAddress) {
  console.log(`[Engine] Full history for ${walletAddress}...`);
  try {
    const r = await moralis.get(`/wallets/${walletAddress}/swaps`, {
      params: { chain: CHAIN, limit: 50 }
    });

    const swaps = r.data.result || [];
    const tokenMap = new Map();

    for (const swap of swaps) {
      const isBuy = swap.transactionType === "buy";
      const tokenAddr = isBuy ? swap.bought?.address : swap.sold?.address;
      if (!tokenAddr) continue;

      const ts = new Date(swap.blockTimestamp).getTime();
      const usdAmount = swap.totalValueUsd || 0;

      if (!tokenMap.has(tokenAddr)) {
        tokenMap.set(tokenAddr, {
          address: tokenAddr,
          symbol: isBuy ? swap.bought?.symbol : swap.sold?.symbol,
          name: isBuy ? swap.bought?.name : swap.sold?.name,
          logo: isBuy ? swap.bought?.logo : swap.sold?.logo,
          buyUsd: 0, sellUsd: 0,
          firstBuyTs: null, lastTs: null,
          buyCount: 0, sellCount: 0,
        });
      }

      const t = tokenMap.get(tokenAddr);
      if (isBuy) { t.buyUsd += usdAmount; t.buyCount++; }
      else { t.sellUsd += usdAmount; t.sellCount++; }
      if (!t.firstBuyTs || ts < t.firstBuyTs) t.firstBuyTs = ts;
      if (!t.lastTs || ts > t.lastTs) t.lastTs = ts;
    }

    const tokens = [...tokenMap.values()].map(t => ({
      ...t,
      pnlUsd: parseFloat((t.sellUsd - t.buyUsd).toFixed(2)),
      buyUsd: parseFloat(t.buyUsd.toFixed(2)),
      sellUsd: parseFloat(t.sellUsd.toFixed(2)),
      stillActive: t.sellCount === 0,
    })).sort((a, b) => b.buyUsd - a.buyUsd);

    return {
      address: walletAddress,
      totalTokensTraded: tokens.length,
      totalBuyUsd: parseFloat(tokens.reduce((s, t) => s + t.buyUsd, 0).toFixed(2)),
      totalSellUsd: parseFloat(tokens.reduce((s, t) => s + t.sellUsd, 0).toFixed(2)),
      tokens,
      analyzedAt: Date.now(),
    };
  } catch (e) {
    console.log("[Engine] wallet history error:", e.response?.data?.message || e.message);
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { reconstructTokenTrades, getWalletFullHistory, getTokenInfo, getEthPrice };
