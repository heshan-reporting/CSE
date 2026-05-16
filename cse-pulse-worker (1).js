/**
 * CSE Pulse — Cloudflare Worker
 * ─────────────────────────────────────────────────────────────
 * Single worker handles:
 *   GET  /api/market          → CSE indices + all stock prices
 *   GET  /api/movers          → top gainers / losers / volume
 *   GET  /api/stock/:symbol   → single stock detail + chart data
 *   GET  /api/sectors         → sector heatmap data
 *   GET  /api/forex           → USD/LKR, gold, bond yield
 *   GET  /api/news            → Marketaux news + sentiment
 *   GET  /api/cbsl            → CBSL exchange rate scrape
 *   POST /api/stocksense      → Stock Sense LK (Anthropic Claude)
 *   GET  /api/status          → market open/closed + countdown
 *   GET  /api/cache/clear     → admin: force-refresh all KV caches
 *
 * KV caching strategy:
 *   market data   → TTL 90s  (near real-time during trading)
 *   news          → TTL 900s (15 min)
 *   forex         → TTL 300s (5 min)
 *   cbsl rates    → TTL 3600s (1hr — updated once daily)
 *
 * Bindings (wrangler.toml):
 *   KV:      CSE_KV
 *   Secrets: ALPHA_VANTAGE_KEY, ANTHROPIC_API_KEY,
 *            ADMIN_TOKEN, ALLOWED_ORIGIN
 */

// ─── CORS helper ──────────────────────────────────────────────
function cors(env) {
  const origin = env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

function json(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: cors(env),
  });
}

function err(msg, env, status = 500) {
  return json({ error: msg, ok: false }, env, status);
}

// ─── KV helpers ───────────────────────────────────────────────
async function kvGet(kv, key) {
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function kvSet(kv, key, data, ttl) {
  await kv.put(key, JSON.stringify(data), { expirationTtl: ttl });
}

// ─── Market hours helper ──────────────────────────────────────
// CSE: Mon–Fri, 09:30–14:30 IST = 04:00–09:00 UTC
function marketStatus() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const day  = now.getUTCDay(); // 0=Sun, 6=Sat
  const totalMin = utcH * 60 + utcM;

  const isWeekday   = day >= 1 && day <= 5;
  const openUTC     = 4 * 60;       // 04:00 UTC = 09:30 IST
  const closeUTC    = 9 * 60;       // 09:00 UTC = 14:30 IST
  const isOpen      = isWeekday && totalMin >= openUTC && totalMin < closeUTC;

  // Minutes to open/close
  let minsTo = 0;
  if (isOpen) {
    minsTo = closeUTC - totalMin;
  } else if (isWeekday && totalMin < openUTC) {
    minsTo = openUTC - totalMin;
  } else {
    // Next weekday open
    const daysAway = day === 5 ? 3 : day === 6 ? 2 : 1;
    minsTo = (daysAway * 24 * 60) + (openUTC - totalMin);
  }

  return { isOpen, minsToEvent: minsTo, isWeekday };
}

// ─── CSE API fetch (proxy bypasses CORS) ─────────────────────
const CSE_BASE = 'https://www.cse.lk/api';

async function cseGet(path, body = null) {
  const url = `${CSE_BASE}/${path}`;
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }
    : { method: 'GET', headers: { 'Accept': 'application/json' } };
  opts.headers['User-Agent'] = 'Mozilla/5.0 CSEPulse/1.0';
  opts.headers['Referer']    = 'https://www.cse.lk/';
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`CSE ${path} → HTTP ${res.status}`);
  return res.json();
}

// ─── ROUTE HANDLERS ───────────────────────────────────────────

// GET /api/status
async function handleStatus(env) {
  const status = marketStatus();
  return json({ ok: true, ...status, timestamp: new Date().toISOString() }, env);
}

// GET /api/market  → indices + all stocks
async function handleMarket(env) {
  const CACHE_KEY = 'market:v1';
  const TTL = marketStatus().isOpen ? 90 : 300;

  const cached = await kvGet(env.CSE_KV, CACHE_KEY);
  if (cached) return json({ ok: true, source: 'cache', ...cached }, env);

  try {
    // Fetch in parallel
    const [summary, prices, aspiRaw, sl20Raw] = await Promise.all([
      cseGet('marketSummery'),
      cseGet('todaySharePrice'),
      cseGet('aspiData'),
      cseGet('snpData'),
    ]);

    const data = {
      summary: normaliseSummary(summary),
      stocks:  normaliseStocks(prices),
      aspi:    normaliseIndex(aspiRaw, 'ASPI'),
      sl20:    normaliseIndex(sl20Raw, 'S&P SL20'),
      updatedAt: Date.now(),
    };

    await kvSet(env.CSE_KV, CACHE_KEY, data, TTL);
    return json({ ok: true, source: 'live', ...data }, env);
  } catch (e) {
    // Return stale cache if available rather than failing hard
    const stale = await kvGet(env.CSE_KV, CACHE_KEY + ':stale');
    if (stale) return json({ ok: true, source: 'stale', ...stale }, env);
    return err(`CSE fetch failed: ${e.message}`, env);
  }
}

// GET /api/movers
async function handleMovers(env) {
  const CACHE_KEY = 'movers:v1';
  const TTL = 120;

  const cached = await kvGet(env.CSE_KV, CACHE_KEY);
  if (cached) return json({ ok: true, source: 'cache', ...cached }, env);

  try {
    const [gainers, losers, active] = await Promise.all([
      cseGet('topGainers'),
      cseGet('topLooses'),
      cseGet('mostActiveTrades'),
    ]);

    const data = {
      gainers: normaliseMover(gainers),
      losers:  normaliseMover(losers),
      active:  normaliseMover(active),
      updatedAt: Date.now(),
    };

    await kvSet(env.CSE_KV, CACHE_KEY, data, TTL);
    return json({ ok: true, source: 'live', ...data }, env);
  } catch (e) {
    return err(`Movers fetch failed: ${e.message}`, env);
  }
}

// GET /api/sectors
async function handleSectors(env) {
  const CACHE_KEY = 'sectors:v1';
  const cached = await kvGet(env.CSE_KV, CACHE_KEY);
  if (cached) return json({ ok: true, source: 'cache', sectors: cached }, env);

  try {
    const raw = await cseGet('allSectors');
    const sectors = normaliseSectors(raw);
    await kvSet(env.CSE_KV, CACHE_KEY, sectors, 180);
    return json({ ok: true, source: 'live', sectors }, env);
  } catch (e) {
    return err(`Sectors fetch failed: ${e.message}`, env);
  }
}

// GET /api/stock/:symbol   e.g. /api/stock/JKH.N0000
async function handleStock(symbol, env) {
  if (!symbol) return err('Symbol required', env, 400);
  const CACHE_KEY = `stock:${symbol}:v1`;
  const cached = await kvGet(env.CSE_KV, CACHE_KEY);
  if (cached) return json({ ok: true, source: 'cache', ...cached }, env);

  try {
    const [info, chart] = await Promise.all([
      cseGet('companyInfoSummery', `symbol=${encodeURIComponent(symbol)}`),
      cseGet('chartData',          `symbol=${encodeURIComponent(symbol)}&period=1M`),
    ]);

    const data = {
      info:  normaliseStockInfo(info, symbol),
      chart: normaliseChart(chart),
      updatedAt: Date.now(),
    };

    await kvSet(env.CSE_KV, CACHE_KEY, data, 120);
    return json({ ok: true, source: 'live', ...data }, env);
  } catch (e) {
    return err(`Stock fetch failed for ${symbol}: ${e.message}`, env);
  }
}

// GET /api/forex
async function handleForex(env) {
  const CACHE_KEY = 'forex:v1';
  const cached = await kvGet(env.CSE_KV, CACHE_KEY);
  if (cached) return json({ ok: true, source: 'cache', ...cached }, env);

  const key = env.ALPHA_VANTAGE_KEY;
  if (!key) return err('ALPHA_VANTAGE_KEY not set', env, 500);

  try {
    // USD/LKR + Gold in parallel
    const [lkrRes, goldRes] = await Promise.all([
      fetch(`https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=LKR&apikey=${key}`),
      fetch(`https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=XAU&to_currency=USD&apikey=${key}`),
    ]);

    const [lkrData, goldData] = await Promise.all([lkrRes.json(), goldRes.json()]);

    const lkr  = lkrData['Realtime Currency Exchange Rate'];
    const gold = goldData['Realtime Currency Exchange Rate'];

    const data = {
      usdLkr: {
        rate:     parseFloat(lkr?.['5. Exchange Rate'] || 0),
        bid:      parseFloat(lkr?.['8. Bid Price']     || 0),
        ask:      parseFloat(lkr?.['9. Ask Price']     || 0),
        time:     lkr?.['6. Last Refreshed'],
      },
      gold: {
        usdPerOz: parseFloat(gold?.['5. Exchange Rate'] || 0),
        time:     gold?.['6. Last Refreshed'],
      },
      updatedAt: Date.now(),
    };

    await kvSet(env.CSE_KV, CACHE_KEY, data, 300);
    return json({ ok: true, source: 'live', ...data }, env);
  } catch (e) {
    return err(`Forex fetch failed: ${e.message}`, env);
  }
}

// GET /api/cbsl  — scrape CBSL spot rate
async function handleCBSL(env) {
  const CACHE_KEY = 'cbsl:v1';
  const cached = await kvGet(env.CSE_KV, CACHE_KEY);
  if (cached) return json({ ok: true, source: 'cache', ...cached }, env);

  try {
    // CBSL publishes a JSON endpoint for indicative rates
    const res = await fetch(
      'https://www.cbsl.gov.lk/api/exchange-rates/indicative',
      { headers: { 'Accept': 'application/json', 'Referer': 'https://www.cbsl.gov.lk/' } }
    );

    let data = {};
    if (res.ok) {
      const raw = await res.json();
      data = normaliseCBSL(raw);
    } else {
      // Fallback: scrape the HTML page for the rate table
      const html = await (await fetch('https://www.cbsl.gov.lk/en/rates-and-indicators/exchange-rates')).text();
      data = scrapeCBSLRate(html);
    }

    data.updatedAt = Date.now();
    await kvSet(env.CSE_KV, CACHE_KEY, data, 3600);
    return json({ ok: true, source: 'live', ...data }, env);
  } catch (e) {
    // Return last known CBSL rate from KV even if stale
    const stale = await kvGet(env.CSE_KV, 'cbsl:stale');
    if (stale) return json({ ok: true, source: 'stale', ...stale }, env);
    return err(`CBSL fetch failed: ${e.message}`, env);
  }
}

// GET /api/news?q=&country=lk&limit=20
async function handleNews(url, env) {
  const params   = url.searchParams;
  const q        = params.get('q') || '';
  const limit    = Math.min(parseInt(params.get('limit') || '20'), 50);
  const CACHE_KEY = `news:${q}:${limit}:v1`;

  const cached = await kvGet(env.CSE_KV, CACHE_KEY);
  if (cached) return json({ ok: true, source: 'cache', ...cached }, env);

  // ── Try Marketaux first ──
  try {
    const mUrl = new URL('https://api.marketaux.com/v1/news/all');
    mUrl.searchParams.set('countries', 'lk');
    mUrl.searchParams.set('filter_entities', 'true');
    mUrl.searchParams.set('language', 'en');
    mUrl.searchParams.set('limit', String(limit));
    if (q) mUrl.searchParams.set('search', q);
    // Marketaux free token — uses env var if set, else anon
    const token = env.MARKETAUX_KEY || 'YOUR_MARKETAUX_TOKEN';
    mUrl.searchParams.set('api_token', token);

    const mRes = await fetch(mUrl.toString());
    if (mRes.ok) {
      const mData = await mRes.json();
      const articles = (mData.data || []).map(normaliseMarketauxArticle);
      const data = { articles, total: mData.meta?.found || articles.length, updatedAt: Date.now() };
      await kvSet(env.CSE_KV, CACHE_KEY, data, 900);
      return json({ ok: true, source: 'marketaux', ...data }, env);
    }
  } catch (_) { /* fall through to RSS */ }

  // ── Fallback: Economy Next RSS ──
  try {
    const rssRes = await fetch('https://economynext.com/feed');
    const rssXml = await rssRes.text();
    const articles = parseRSS(rssXml).slice(0, limit);
    const data = { articles, total: articles.length, updatedAt: Date.now() };
    await kvSet(env.CSE_KV, CACHE_KEY, data, 900);
    return json({ ok: true, source: 'rss', ...data }, env);
  } catch (e) {
    return err(`News fetch failed: ${e.message}`, env);
  }
}

// POST /api/stocksense  — Stock Sense LK AI engine
async function handleStockSense(request, env) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return err('ANTHROPIC_API_KEY not configured', env, 500);

  let body;
  try { body = await request.json(); }
  catch { return err('Invalid JSON body', env, 400); }

  const { query, context } = body;
  if (!query) return err('query field required', env, 400);

  // Build system prompt with Sri Lanka market context
  const systemPrompt = `You are Stock Sense LK, the AI investment analyst for CSE Pulse — Sri Lanka's premier stock market platform. You specialise exclusively in:
- Colombo Stock Exchange (CSE) listed stocks and indices (ASPI, S&P SL20)
- Sri Lanka's macroeconomic context: IMF programme, CBSL policy, forex reserves, tourism
- Sector analysis: Hotels & Leisure, Banking, Plantations, IT & BPO, Logistics, Manufacturing, Real Estate
- Post-crisis recovery analysis (2022 economic crisis → current recovery)
- Government policy impact on CSE sectors and individual stocks

Your analysis style:
- Data-driven with specific LKR figures, P/E ratios, and percentage changes
- Always connect macro events (CBSL rate cuts, IMF reviews, budget policies) to specific stock impacts
- Give clear BUY / HOLD / SELL signals with rationale and price targets in LKR
- Mention risk factors clearly
- Be concise but comprehensive — investors need actionable intelligence

Always end with a brief disclaimer: "This is not financial advice. Please consult a licensed investment advisor."

${context ? `Current market context: ${context}` : ''}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 800,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: query }],
      }),
    });

    if (!res.ok) {
      const e = await res.text();
      return err(`Anthropic error: ${e}`, env, res.status);
    }

    const aiData = await res.json();
    const answer = aiData.content?.[0]?.text || '';
    return json({ ok: true, answer, model: aiData.model, usage: aiData.usage }, env);
  } catch (e) {
    return err(`Stock Sense LK error: ${e.message}`, env);
  }
}

// GET /api/cache/clear  — admin force-refresh
async function handleCacheClear(request, env) {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (token !== env.ADMIN_TOKEN) return err('Unauthorized', env, 401);

  const keys = ['market:v1', 'movers:v1', 'sectors:v1', 'forex:v1', 'cbsl:v1'];
  await Promise.all(keys.map(k => env.CSE_KV.delete(k)));
  return json({ ok: true, cleared: keys }, env);
}

// ─── CRON HANDLER — fires during market hours ─────────────────
async function handleCron(event, env) {
  console.log('Cron fired:', event.cron, new Date().toISOString());

  // Refresh all market caches proactively
  try {
    const [summary, prices, gainers, losers, active, sectors] = await Promise.all([
      cseGet('marketSummery'),
      cseGet('todaySharePrice'),
      cseGet('topGainers'),
      cseGet('topLooses'),
      cseGet('mostActiveTrades'),
      cseGet('allSectors'),
    ]);

    const market = {
      summary:   normaliseSummary(summary),
      stocks:    normaliseStocks(prices),
      updatedAt: Date.now(),
    };
    const movers = {
      gainers:   normaliseMover(gainers),
      losers:    normaliseMover(losers),
      active:    normaliseMover(active),
      updatedAt: Date.now(),
    };
    const sectorData = normaliseSectors(sectors);

    await Promise.all([
      kvSet(env.CSE_KV, 'market:v1',  market,     90),
      kvSet(env.CSE_KV, 'market:v1:stale', market, 86400), // keep stale for 24h
      kvSet(env.CSE_KV, 'movers:v1',  movers,     120),
      kvSet(env.CSE_KV, 'sectors:v1', sectorData, 180),
    ]);
    console.log('Cron: market cache refreshed OK');
  } catch (e) {
    console.error('Cron error:', e.message);
  }
}

// ─── DATA NORMALISERS ─────────────────────────────────────────

function normaliseSummary(raw) {
  // CSE marketSummery returns different keys — normalise to consistent shape
  const d = Array.isArray(raw) ? raw[0] : raw;
  return {
    aspi:      parseFloat(d?.aspiIndexValue   || d?.indexValue   || 0),
    aspiChg:   parseFloat(d?.aspiChange       || d?.change       || 0),
    aspiChgPct:parseFloat(d?.aspiChangePercent|| d?.changePercent|| 0),
    turnover:  parseFloat(d?.turnover         || 0),
    volume:    parseFloat(d?.volume           || 0),
    trades:    parseInt(  d?.trades           || d?.noOfTrades   || 0),
    advances:  parseInt(  d?.advances         || 0),
    declines:  parseInt(  d?.declines         || 0),
    unchanged: parseInt(  d?.unchanged        || 0),
  };
}

function normaliseStocks(raw) {
  const list = Array.isArray(raw) ? raw : raw?.data || [];
  return list.map(s => ({
    symbol:   s.symbol         || s.stockSymbol     || '',
    name:     s.stockName      || s.companyName     || '',
    price:    parseFloat(s.lastTradedPrice || s.closePrice || 0),
    change:   parseFloat(s.change         || 0),
    changePct:parseFloat(s.changePercentage|| s.changePct || 0),
    volume:   parseInt(  s.volume         || 0),
    high:     parseFloat(s.high           || 0),
    low:      parseFloat(s.low            || 0),
    open:     parseFloat(s.openPrice      || 0),
  })).filter(s => s.symbol);
}

function normaliseIndex(raw, name) {
  const d = Array.isArray(raw) ? raw[0] : raw;
  return {
    name,
    value:     parseFloat(d?.indexValue    || d?.value      || 0),
    change:    parseFloat(d?.change        || 0),
    changePct: parseFloat(d?.changePercent || d?.changePct  || 0),
    // intraday array for chart — CSE returns [{time, value}] or similar
    intraday: (d?.intradayData || d?.chartData || []).map(p => ({
      t: p.time || p.t,
      v: parseFloat(p.value || p.v || 0),
    })),
  };
}

function normaliseMover(raw) {
  const list = Array.isArray(raw) ? raw : raw?.data || [];
  return list.slice(0, 10).map(s => ({
    symbol:   s.symbol         || s.stockSymbol || '',
    name:     s.stockName      || s.companyName || '',
    price:    parseFloat(s.lastTradedPrice || s.closePrice || 0),
    change:   parseFloat(s.change     || 0),
    changePct:parseFloat(s.changePercentage || s.changePct || 0),
    volume:   parseInt(  s.volume     || 0),
  }));
}

function normaliseSectors(raw) {
  const list = Array.isArray(raw) ? raw : raw?.data || [];
  return list.map(s => ({
    name:     s.sectorName    || s.name     || '',
    index:    parseFloat(s.sectorIndex   || s.value    || 0),
    change:   parseFloat(s.change        || 0),
    changePct:parseFloat(s.changePercent || s.changePct|| 0),
    turnover: parseFloat(s.turnover      || 0),
  }));
}

function normaliseStockInfo(raw, symbol) {
  const d = Array.isArray(raw) ? raw[0] : raw;
  return {
    symbol,
    name:       d?.companyName    || '',
    sector:     d?.sector         || '',
    price:      parseFloat(d?.lastTradedPrice || 0),
    open:       parseFloat(d?.openPrice       || 0),
    high52:     parseFloat(d?.week52High      || 0),
    low52:      parseFloat(d?.week52Low       || 0),
    pe:         parseFloat(d?.pe              || 0),
    eps:        parseFloat(d?.eps             || 0),
    marketCap:  parseFloat(d?.marketCap       || 0),
    shares:     parseFloat(d?.noOfShares      || 0),
    dividend:   parseFloat(d?.dividend        || 0),
    divYield:   parseFloat(d?.dividendYield   || 0),
  };
}

function normaliseChart(raw) {
  const list = Array.isArray(raw) ? raw : raw?.data || [];
  return list.map(p => ({
    date:  p.date  || p.d || '',
    open:  parseFloat(p.open  || p.o || 0),
    high:  parseFloat(p.high  || p.h || 0),
    low:   parseFloat(p.low   || p.l || 0),
    close: parseFloat(p.close || p.c || 0),
    vol:   parseInt( p.volume || p.v || 0),
  }));
}

function normaliseCBSL(raw) {
  // CBSL JSON varies — attempt to extract USD/LKR buying/selling
  const rates = Array.isArray(raw) ? raw : raw?.rates || [];
  const usdRow = rates.find(r =>
    (r.currency || r.code || '').toLowerCase().includes('usd') ||
    (r.currency || r.code || '').toLowerCase().includes('us dollar')
  );
  return {
    usdBuying:  parseFloat(usdRow?.buying  || usdRow?.buy  || 0),
    usdSelling: parseFloat(usdRow?.selling || usdRow?.sell || 0),
    date:       usdRow?.date || new Date().toISOString().slice(0, 10),
    source:     'CBSL Official',
  };
}

function scrapeCBSLRate(html) {
  // Regex fallback — CBSL HTML table usually has "US Dollar" row
  const match = html.match(/US\s*Dollar[\s\S]{0,200}?(\d{2,3}[.,]\d{2,4})/i);
  const rate   = match ? parseFloat(match[1].replace(',', '')) : 0;
  return { usdBuying: rate, usdSelling: rate + 2, source: 'CBSL Scraped' };
}

function normaliseMarketauxArticle(a) {
  return {
    id:          a.uuid,
    title:       a.title,
    description: a.description,
    url:         a.url,
    source:      a.source,
    publishedAt: a.published_at,
    sentiment:   a.entities?.[0]?.sentiment_score ?? null,
    entities:    (a.entities || []).map(e => e.name),
    imageUrl:    a.image_url,
  };
}

function parseRSS(xml) {
  // Minimal RSS 2.0 parser — Worker env has no DOM parser
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const item  = m[1];
    const get   = tag => (item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || (item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
    items.push({
      title:       get('title').trim(),
      url:         get('link').trim(),
      description: get('description').replace(/<[^>]+>/g, '').trim().slice(0, 200),
      publishedAt: get('pubDate').trim(),
      source:      'Economy Next',
      sentiment:   null,
    });
  }
  return items;
}

// ─── MAIN FETCH HANDLER ───────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    // Route dispatch
    try {
      // ── Market data ──
      if (path === '/api/market'  && method === 'GET') return handleMarket(env);
      if (path === '/api/movers'  && method === 'GET') return handleMovers(env);
      if (path === '/api/sectors' && method === 'GET') return handleSectors(env);
      if (path === '/api/forex'   && method === 'GET') return handleForex(env);
      if (path === '/api/cbsl'    && method === 'GET') return handleCBSL(env);
      if (path === '/api/status'  && method === 'GET') return handleStatus(env);
      if (path === '/api/news'    && method === 'GET') return handleNews(url, env);

      // ── Stock detail: /api/stock/JKH.N0000 ──
      const stockMatch = path.match(/^\/api\/stock\/([^/]+)$/);
      if (stockMatch && method === 'GET') return handleStock(decodeURIComponent(stockMatch[1]), env);

      // ── Stock Sense LK AI ──
      if (path === '/api/stocksense' && method === 'POST') return handleStockSense(request, env);

      // ── Admin ──
      if (path === '/api/cache/clear' && method === 'GET') return handleCacheClear(request, env);

      // ── Health check ──
      if (path === '/api/health') return json({ ok: true, service: 'CSE Pulse Worker', version: '1.0.0', ts: Date.now() }, env);

      return json({ error: 'Not found', path }, env, 404);
    } catch (e) {
      console.error('Unhandled error:', e);
      return err(`Internal server error: ${e.message}`, env, 500);
    }
  },

  // ── Cron scheduled handler ──
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(event, env));
  },
};
