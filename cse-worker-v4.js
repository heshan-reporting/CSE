/**
 * CSE Pulse — Cloudflare Worker v4.1
 * ─────────────────────────────────────────────────────────────
 * CHANGES in v4.1 (from v4):
 *   - Added /api/crisis route — Global Crisis → SL Chain Reaction
 *     • Dedicated Claude call with max_tokens 2500
 *     • Returns structured JSON rendered by the frontend
 *     • KV cached for 6 hours to avoid redundant AI calls
 *     • forceRefresh=true bypasses cache
 *
 * Routes:
 *   GET  /api/health       → health check
 *   GET  /api/status       → market open/closed
 *   GET  /api/market       → ASPI + all stocks
 *   GET  /api/movers       → gainers / losers / volume
 *   GET  /api/sectors      → sector heatmap
 *   GET  /api/forex        → USD/LKR + major currencies + gold
 *   GET  /api/news         → Sri Lanka financial news (with images)
 *   GET  /api/worldnews    → World financial news (with images)
 *   POST /api/stocksense   → Stock Sense LK AI
 *   POST /api/crisis       → Global Crisis → SL Chain Reaction AI ← NEW
 *   GET  /api/cache/clear  → admin clear cache
 */

// ═══════════════════════════════════════════════════
//  RESPONSE HELPERS
// ═══════════════════════════════════════════════════

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin':  env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

const okRes  = (data, env)        => new Response(JSON.stringify({ ok: true,  ...data }), { headers: corsHeaders(env) });
const errRes = (msg,  env, s=500) => new Response(JSON.stringify({ ok: false, error: msg }), { status: s, headers: corsHeaders(env) });

// ═══════════════════════════════════════════════════
//  KV HELPERS
// ═══════════════════════════════════════════════════

async function kvGet(kv, key) {
  try { const v = await kv.get(key); return v ? JSON.parse(v) : null; }
  catch { return null; }
}

async function kvSet(kv, key, data, ttl) {
  try { await kv.put(key, JSON.stringify(data), { expirationTtl: ttl }); }
  catch (e) { console.error('KV write failed:', key, e.message); }
}

// ═══════════════════════════════════════════════════
//  MARKET STATUS — CSE Mon-Fri 09:30-14:30 IST
// ═══════════════════════════════════════════════════

function marketStatus() {
  const now   = new Date();
  const day   = now.getUTCDay();
  const mins  = now.getUTCHours() * 60 + now.getUTCMinutes();
  const OPEN  = 4  * 60;   // 04:00 UTC = 09:30 IST
  const CLOSE = 9  * 60;   // 09:00 UTC = 14:30 IST
  const isWeekday = day >= 1 && day <= 5;
  const isOpen    = isWeekday && mins >= OPEN && mins < CLOSE;
  let minsTo = 0;
  if      (isOpen)                      minsTo = CLOSE - mins;
  else if (isWeekday && mins < OPEN)    minsTo = OPEN  - mins;
  else { const d = day===5?3:day===6?2:1; minsTo = d*1440+(OPEN-mins); }
  return { isOpen, minsToEvent: minsTo, isWeekday };
}

// ═══════════════════════════════════════════════════
//  CSE API
// ═══════════════════════════════════════════════════

const CSE_BASE = 'https://www.cse.lk/api';
const CSE_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept':       'application/json, text/plain, */*',
  'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer':      'https://www.cse.lk/',
  'Origin':       'https://www.cse.lk',
};

function looksLikeJson(text) {
  const t = (text || '').trim();
  return t.startsWith('[') || t.startsWith('{');
}

async function cseFetch(path, params = '') {
  const url = `${CSE_BASE}/${path}`;
  try {
    const r = await fetch(url, { method: 'POST', headers: CSE_HEADERS, body: params });
    if (r.ok) { const t = await r.text(); if (looksLikeJson(t)) return JSON.parse(t); }
  } catch (_) {}
  try {
    const r = await fetch(params ? `${url}?${params}` : url, { method: 'GET', headers: CSE_HEADERS });
    if (r.ok) { const t = await r.text(); if (looksLikeJson(t)) return JSON.parse(t); }
  } catch (_) {}
  return null;
}

// ═══════════════════════════════════════════════════
//  DATA NORMALISERS
// ═══════════════════════════════════════════════════

const num = v => parseFloat(v) || 0;
const int = v => parseInt(v)   || 0;

function normaliseSummary(raw) {
  if (!raw) return { aspi:0, aspiChg:0, aspiChgPct:0, sl20:0, turnover:0, volume:0, trades:0, advances:0, declines:0, unchanged:0 };
  const d = Array.isArray(raw) ? raw[0] : raw;

  const aspi =
    num(d.aspiIndexValue)     || num(d.aspi_index_value)   ||
    num(d.ASPIIndexValue)     || num(d.indexValue)         ||
    num(d.currentValue)       || num(d.value)              || 0;

  const aspiChg =
    num(d.aspiChange)         || num(d.aspi_change)        ||
    num(d.ASPIChange)         || num(d.change)             || 0;

  const aspiChgPct =
    num(d.aspiChangePercent)  || num(d.aspi_change_percent)||
    num(d.changePercent)      || num(d.changePct)          ||
    num(d.percentChange)      || 0;

  return {
    aspi, aspiChg, aspiChgPct,
    sl20:      num(d.snpIndexValue || d.sl20 || 0),
    turnover:  num(d.turnover  || 0),
    volume:    num(d.volume    || 0),
    trades:    int(d.trades    || d.noOfTrades || 0),
    advances:  int(d.advances  || 0),
    declines:  int(d.declines  || 0),
    unchanged: int(d.unchanged || 0),
  };
}

function normaliseStocks(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (raw.data || []);
  return list.map(s => ({
    symbol:    s.symbol        || s.stockSymbol  || '',
    name:      s.stockName     || s.companyName  || '',
    price:     num(s.lastTradedPrice || s.closePrice || s.price || 0),
    change:    num(s.change    || 0),
    changePct: num(s.changePercentage || s.changePct || s.percentChange || 0),
    volume:    int(s.volume    || 0),
    high:      num(s.high      || s.dayHigh || 0),
    low:       num(s.low       || s.dayLow  || 0),
    open:      num(s.openPrice || s.open    || 0),
  })).filter(s => s.symbol && s.price > 0);
}

function normaliseMover(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (raw.data || []);
  return list.slice(0, 10).map(s => ({
    symbol:    s.symbol    || s.stockSymbol || '',
    name:      s.stockName || s.companyName || '',
    price:     num(s.lastTradedPrice || s.closePrice || 0),
    change:    num(s.change    || 0),
    changePct: num(s.changePercentage || s.changePct || 0),
    volume:    int(s.volume    || 0),
  }));
}

function normaliseSectors(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (raw.data || []);
  return list.map(s => ({
    name:      s.sectorName    || s.name        || '',
    index:     num(s.sectorIndex   || s.value       || 0),
    change:    num(s.change        || 0),
    changePct: num(s.changePercent || s.changePct   || 0),
    turnover:  num(s.turnover      || 0),
  }));
}

// ═══════════════════════════════════════════════════
//  FOREX
// ═══════════════════════════════════════════════════

async function fetchForexFree() {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    if (r.ok) {
      const d = await r.json();
      if (d.rates?.LKR) {
        return {
          usdLkr: { rate: num(d.rates.LKR), bid: 0, ask: 0, time: d.date },
          eur:    { rate: num(d.rates.EUR || 0) },
          gbp:    { rate: num(d.rates.GBP || 0) },
          jpy:    { rate: num(d.rates.JPY || 0) },
          source: 'exchangerate-api.com',
        };
      }
    }
  } catch (_) {}

  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    if (r.ok) {
      const d = await r.json();
      if (d.rates?.LKR) {
        return {
          usdLkr: { rate: num(d.rates.LKR), bid: 0, ask: 0, time: d.time_last_update_utc },
          eur:    { rate: num(d.rates.EUR || 0) },
          gbp:    { rate: num(d.rates.GBP || 0) },
          jpy:    { rate: num(d.rates.JPY || 0) },
          source: 'open.er-api.com',
        };
      }
    }
  } catch (_) {}

  try {
    const r = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json');
    if (r.ok) {
      const d = await r.json();
      if (d.usd?.lkr) {
        return {
          usdLkr: { rate: num(d.usd.lkr), bid: 0, ask: 0, time: d.date },
          eur:    { rate: num(d.usd.eur || 0) },
          gbp:    { rate: num(d.usd.gbp || 0) },
          jpy:    { rate: num(d.usd.jpy || 0) },
          source: 'jsdelivr-currency-api',
        };
      }
    }
  } catch (_) {}

  return null;
}

async function handleForex(env) {
  const KEY = 'forex:v1';
  const cached = await kvGet(env.CSE_KV, KEY);
  if (cached) return okRes({ source: 'cache', ...cached }, env);

  let forexData = await fetchForexFree();

  if (!forexData && env.ALPHA_VANTAGE_KEY) {
    try {
      const r = await fetch(`https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=LKR&apikey=${env.ALPHA_VANTAGE_KEY}`);
      const d = await r.json();
      const lkr = d['Realtime Currency Exchange Rate'];
      if (lkr && !lkr.Note) {
        forexData = { usdLkr: { rate: num(lkr['5. Exchange Rate']), bid: num(lkr['8. Bid Price']), ask: num(lkr['9. Ask Price']), time: lkr['6. Last Refreshed'] }, source: 'alphavantage' };
      }
    } catch(_) {}
  }

  if (!forexData) {
    const stale = await kvGet(env.CSE_KV, KEY + ':stale');
    if (stale) return okRes({ source: 'stale', ...stale }, env);
    forexData = { usdLkr: { rate: 329.14, bid: 328.50, ask: 329.80, time: 'hardcoded-fallback' }, source: 'fallback-hardcoded' };
  }

  const data = { ...forexData, updatedAt: Date.now() };
  await kvSet(env.CSE_KV, KEY, data, 300);
  await kvSet(env.CSE_KV, KEY + ':stale', data, 86400);
  return okRes({ source: forexData.source || 'live', ...data }, env);
}

// ═══════════════════════════════════════════════════
//  RSS PARSER — v4: enhanced image extraction
// ═══════════════════════════════════════════════════

function extractImage(itemBlock) {
  let m = itemBlock.match(/media:content[^>]+url="([^"]+)"/i);
  if (m) return m[1];
  m = itemBlock.match(/media:thumbnail[^>]+url="([^"]+)"/i);
  if (m) return m[1];
  m = itemBlock.match(/enclosure[^>]+url="([^"]+\.(?:jpg|jpeg|png|gif|webp))"/i);
  if (m) return m[1];
  m = itemBlock.match(/enclosure[^>]+type="image[^"]*"[^>]+url="([^"]+)"/i)
    || itemBlock.match(/enclosure[^>]+url="([^"]+)"[^>]+type="image[^"]*"/i);
  if (m) return m[1];
  const descMatch = itemBlock.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
  if (descMatch) {
    const imgM = descMatch[1].match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgM) return imgM[1];
    const urlM = descMatch[1].match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/i);
    if (urlM) return urlM[0];
  }
  m = itemBlock.match(/og:image"[^>]+content="([^"]+)"/i)
    || itemBlock.match(/content="([^"]+)"[^>]+property="og:image"/i);
  if (m) return m[1];
  return null;
}

function parseRSS(xml, defaultSource = '') {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b   = m[1];
    const get = tag => {
      const r1 = b.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
      if (r1) return r1[1].trim();
      const r2 = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return r2 ? r2[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim() : '';
    };

    const title = get('title');
    if (title) {
      let description = get('description');
      description = description.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,400);

      items.push({
        title,
        url:         get('link'),
        description,
        publishedAt: get('pubDate'),
        source:      get('dc:creator') || get('author') || defaultSource,
        feedSource:  defaultSource,
        category:    get('category'),
        imageUrl:    extractImage(b),
        sentiment:   null,
      });
    }
  }
  return items;
}

async function fetchFeeds(feeds, limit) {
  const results = await Promise.allSettled(
    feeds.map(async feed => {
      const r = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 CSEPulse/4.1', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
        cf: { cacheTtl: 60 },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const xml      = await r.text();
      const articles = parseRSS(xml, feed.source);
      return articles.map(a => ({ ...a, feedSource: feed.source }));
    })
  );

  const all = [];
  results.forEach(r => { if (r.status === 'fulfilled') all.push(...r.value); });

  all.sort((a, b) => {
    const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return db - da;
  });

  const seen = new Set();
  const unique = all.filter(a => {
    const key = a.title.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.slice(0, limit);
}

// ═══════════════════════════════════════════════════
//  NEWS FEEDS
// ═══════════════════════════════════════════════════

const SL_FEEDS = [
  { url: 'https://economynext.com/feed',             source: 'Economy Next'  },
  { url: 'https://www.ft.lk/rss',                    source: 'Daily FT'      },
  { url: 'https://www.lankabusinessonline.com/feed', source: 'LBO'           },
  { url: 'https://adaderana.lk/rss.php',             source: 'Ada Derana'    },
  { url: 'https://www.newswire.lk/feed/',            source: 'Newswire.lk'   },
];

const WORLD_FEEDS = [
  { url: 'https://feeds.reuters.com/reuters/businessNews',        source: 'Reuters'       },
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml',       source: 'BBC Business'  },
  { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html', source: 'CNBC'          },
  { url: 'https://finance.yahoo.com/news/rssindex',               source: 'Yahoo Finance' },
  { url: 'https://www.investing.com/rss/news.rss',               source: 'Investing.com' },
];

async function handleNews(reqUrl, env) {
  const limit = Math.min(parseInt(reqUrl.searchParams.get('limit') || '24'), 60);
  const q     = reqUrl.searchParams.get('q') || '';
  const KEY   = `news:lk:${q}:${limit}`;

  const cached = await kvGet(env.CSE_KV, KEY);
  if (cached) return okRes({ source: 'cache', ...cached }, env);

  if (env.MARKETAUX_KEY) {
    try {
      const u = new URL('https://api.marketaux.com/v1/news/all');
      u.searchParams.set('countries', 'lk');
      u.searchParams.set('filter_entities', 'true');
      u.searchParams.set('language', 'en');
      u.searchParams.set('limit', String(limit));
      u.searchParams.set('api_token', env.MARKETAUX_KEY);
      if (q) u.searchParams.set('search', q);

      const r = await fetch(u.toString());
      if (r.ok) {
        const d = await r.json();
        if (d.data?.length > 0) {
          const articles = d.data.map(a => ({
            title:       a.title,
            description: a.description,
            url:         a.url,
            source:      a.source,
            feedSource:  a.source,
            publishedAt: a.published_at,
            sentiment:   a.entities?.[0]?.sentiment_score ?? null,
            imageUrl:    a.image_url,
          }));
          const data = { articles, total: d.meta?.found || articles.length, updatedAt: Date.now() };
          await kvSet(env.CSE_KV, KEY, data, 180);
          return okRes({ source: 'marketaux', ...data }, env);
        }
      }
    } catch (_) {}
  }

  const articles = await fetchFeeds(SL_FEEDS, limit);
  const data = { articles, total: articles.length, updatedAt: Date.now() };
  await kvSet(env.CSE_KV, KEY, data, 180);
  return okRes({ source: 'rss', ...data }, env);
}

async function handleWorldNews(reqUrl, env) {
  const limit = Math.min(parseInt(reqUrl.searchParams.get('limit') || '20'), 60);
  const KEY   = `news:world:${limit}`;

  const cached = await kvGet(env.CSE_KV, KEY);
  if (cached) return okRes({ source: 'cache', ...cached }, env);

  const articles = await fetchFeeds(WORLD_FEEDS, limit);
  const data = { articles, total: articles.length, updatedAt: Date.now() };
  await kvSet(env.CSE_KV, KEY, data, 300);
  return okRes({ source: 'rss-world', ...data }, env);
}

// ═══════════════════════════════════════════════════
//  MARKET ROUTES
// ═══════════════════════════════════════════════════

async function handleMarket(env) {
  const KEY = 'market:v1';
  const TTL = marketStatus().isOpen ? 90 : 300;

  const cached = await kvGet(env.CSE_KV, KEY);
  if (cached) return okRes({ source: 'cache', ...cached }, env);

  const [summary, prices] = await Promise.all([
    cseFetch('marketSummery'),
    cseFetch('todaySharePrice'),
  ]);

  const [aspiRaw, sl20Raw] = await Promise.allSettled([
    cseFetch('aspiData'),
    cseFetch('snpData'),
  ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : null));

  const normSummary = normaliseSummary(summary);
  const data = {
    summary:   normSummary,
    stocks:    normaliseStocks(prices),
    aspiChart: extractIntraday(aspiRaw),
    sl20Chart: extractIntraday(sl20Raw),
    updatedAt: Date.now(),
  };

  if (data.stocks.length > 0 || data.summary.aspi > 100) {
    await kvSet(env.CSE_KV, KEY, data, TTL);
    await kvSet(env.CSE_KV, KEY + ':stale', data, 86400);
  }

  return okRes({ source: 'live', ...data }, env);
}

function extractIntraday(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (raw.data || raw.intradayData || []);
  return list.map(p => ({ t: p.time || p.t || '', v: num(p.value || p.v || 0) }));
}

async function handleMovers(env) {
  const KEY = 'movers:v1';
  const cached = await kvGet(env.CSE_KV, KEY);
  if (cached) return okRes({ source: 'cache', ...cached }, env);

  const [g, l, a] = await Promise.all([
    cseFetch('topGainers'),
    cseFetch('topLooses'),
    cseFetch('mostActiveTrades'),
  ]);

  const data = { gainers: normaliseMover(g), losers: normaliseMover(l), active: normaliseMover(a), updatedAt: Date.now() };
  await kvSet(env.CSE_KV, KEY, data, 120);
  return okRes({ source: 'live', ...data }, env);
}

async function handleSectors(env) {
  const KEY = 'sectors:v1';
  const cached = await kvGet(env.CSE_KV, KEY);
  if (cached) return okRes({ source: 'cache', sectors: cached }, env);

  const raw = await cseFetch('allSectors');
  if (!raw) return errRes('Sectors unavailable', env);

  const sectors = normaliseSectors(raw);
  await kvSet(env.CSE_KV, KEY, sectors, 180);
  return okRes({ source: 'live', sectors }, env);
}

// ═══════════════════════════════════════════════════
//  STOCK SENSE LK AI
// ═══════════════════════════════════════════════════

async function handleStockSense(request, env) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return errRes('ANTHROPIC_API_KEY not set', env, 500);

  let body;
  try { body = await request.json(); }
  catch { return errRes('Invalid JSON', env, 400); }

  const { query, context } = body;
  if (!query?.trim()) return errRes('"query" is required', env, 400);

  const system = `You are Stock Sense LK — the AI investment analyst built into CSE Pulse, Sri Lanka's premier stock market platform.

You specialise in:
- Colombo Stock Exchange (CSE): stocks, indices (ASPI, S&P SL20), sectors
- Sri Lanka macro: IMF EFF programme, CBSL policy, forex (USD/LKR ~329), tourism recovery
- Sectors: Hotels & Leisure, Banking, Plantations, IT & BPO, Logistics, Manufacturing, Real Estate
- Post-2022 economic crisis recovery — tracking IMF milestones, debt restructuring, reserves ($5.6B)

Style:
- Lead with data: LKR prices, P/E ratios, % changes
- Connect macro events to specific stocks and sectors
- Clear signals: 🟢 BUY / 🟡 HOLD / 🔴 SELL with LKR price targets
- Mention 1-2 key risks
- Max 200 words, concise and actionable

End every response with: "⚠️ Not financial advice. Consult a licensed investment advisor."
${context ? `\nMarket context: ${context}` : ''}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model:      env.AI_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system,
        messages:   [{ role: 'user', content: query.trim() }],
      }),
    });

    if (!r.ok) return errRes(`Claude API ${r.status}`, env, r.status);
    const d = await r.json();
    return okRes({ answer: d.content?.[0]?.text || '', model: d.model, usage: d.usage }, env);
  } catch (e) {
    return errRes(`Stock Sense LK error: ${e.message}`, env);
  }
}

// ═══════════════════════════════════════════════════
//  CRISIS RADAR — Global Crisis → SL Chain Reaction
//  NEW in v4.1
// ═══════════════════════════════════════════════════

async function handleCrisis(request, env) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return errRes('ANTHROPIC_API_KEY not set', env, 500);

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const forceRefresh = body.forceRefresh === true;

  const CACHE_KEY = 'crisis:v1';
  const CACHE_TTL = 6 * 60 * 60; // 6 hours

  if (!forceRefresh) {
    const cached = await kvGet(env.CSE_KV, CACHE_KEY);
    if (cached) return okRes({ source: 'cache', ...cached }, env);
  }

  const today = new Date().toISOString().slice(0, 10);

  const system = `You are CSE Pulse Crisis Radar — an AI that analyses global crises and their precise economic chain reaction through Sri Lanka. Today is ${today}.

Your job:
1. Identify the single most impactful global crisis this week (geopolitical, financial, commodity, trade, climate, etc.)
2. Map the EXACT transmission mechanism into Sri Lanka's economy step by step
3. Name specific CSE-listed stocks with estimated % price moves
4. Provide an investor strategy narrative

Sri Lanka context: IMF EFF programme (6th/final review due May 2026), ASPI ~12,847, USD/LKR ~329, forex reserves $5.6B, key sectors: Hotels & Leisure (JKH, SPEN, AHUN), Banking (COMB, SAMP, HNB), Plantations (CARS, KLNR), IT/BPO (CALT), Logistics (EXPO).

CRITICAL: Respond ONLY with valid JSON. No markdown. No backticks. No explanation outside the JSON.

JSON schema (all fields required):
{
  "crisis": {
    "type": "TRADE WAR|CURRENCY CRISIS|COMMODITY SHOCK|GEOPOLITICAL|FINANCIAL CRISIS|CLIMATE|OTHER",
    "title": "concise crisis title (max 10 words)",
    "desc": "2-sentence description of the crisis",
    "countries": ["🇺🇸 USA", "🇨🇳 China"],
    "severity": "critical|high|medium"
  },
  "meters": {
    "lkrPressure": 0,
    "importRisk": 0,
    "exportRevenue": 0,
    "sentiment": 0
  },
  "chain": [
    { "n": "01", "ic": "🌍", "t": "step title", "d": "1-sentence impact", "imp": "+/-X%", "ty": "neg|pos|neu" },
    { "n": "02", "ic": "🚢", "t": "step title", "d": "1-sentence impact", "imp": "+/-X%", "ty": "neg|pos|neu" },
    { "n": "03", "ic": "💱", "t": "step title", "d": "1-sentence impact", "imp": "+/-X%", "ty": "neg|pos|neu" },
    { "n": "04", "ic": "🏦", "t": "step title", "d": "1-sentence impact", "imp": "+/-X%", "ty": "neg|pos|neu" },
    { "n": "05", "ic": "🏨", "t": "step title", "d": "1-sentence impact", "imp": "+/-X%", "ty": "neg|pos|neu" }
  ],
  "sectors": [
    { "n": "Hotels & Leisure", "ic": "🏨", "score": -3.5, "ty": "neg|pos|neu", "desc": "1-sentence sector impact", "stocks": [
      { "s": "JKH", "nm": "John Keells", "chg": -2.8, "sig": "BUY|HOLD|SELL" }
    ]},
    { "n": "Banking & Finance", "ic": "🏦", "score": -2.0, "ty": "neg", "desc": "...", "stocks": [
      { "s": "COMB", "nm": "Commercial Bank", "chg": -1.8, "sig": "HOLD" },
      { "s": "SAMP", "nm": "Sampath Bank", "chg": -1.4, "sig": "HOLD" }
    ]},
    { "n": "Logistics & Freight", "ic": "🚢", "score": -6.0, "ty": "neg", "desc": "...", "stocks": [
      { "s": "EXPO", "nm": "Expolanka", "chg": -7.2, "sig": "SELL" }
    ]},
    { "n": "Plantations", "ic": "🍃", "score": 3.5, "ty": "pos", "desc": "...", "stocks": [
      { "s": "CARS", "nm": "Carson Cumberbatch", "chg": 4.1, "sig": "BUY" }
    ]},
    { "n": "IT & BPO", "ic": "💻", "score": 4.0, "ty": "pos", "desc": "...", "stocks": [
      { "s": "CALT", "nm": "Calcey Technologies", "chg": 5.2, "sig": "BUY" }
    ]}
  ],
  "policy": {
    "title": "CBSL & Government Policy Response",
    "nodes": [
      { "n": "01", "lbl": "Policy action name", "d": "What the government or CBSL does", "impact": "+/-X% effect" },
      { "n": "02", "lbl": "Policy action 2", "d": "...", "impact": "..." },
      { "n": "03", "lbl": "Policy action 3", "d": "...", "impact": "..." }
    ],
    "stocks": [
      { "s": "JKH", "sig": "HOLD" },
      { "s": "COMB", "sig": "BUY" },
      { "s": "EXPO", "sig": "SELL" }
    ]
  },
  "gauges": [
    { "t": "Currency Risk", "v": 72, "l": "HIGH", "c": "down" },
    { "t": "Trade Exposure", "v": 65, "l": "HIGH", "c": "down" },
    { "t": "IMF Buffer Strength", "v": 80, "l": "STRONG", "c": "up" },
    { "t": "Tourism Resilience", "v": 60, "l": "MODERATE", "c": "gold" },
    { "t": "Export Revenue Risk", "v": 55, "l": "MODERATE", "c": "gold" }
  ],
  "narrative": "150-200 word investor strategy narrative. What CSE investors should do, which sectors to overweight/underweight, specific stock calls with rationale. End with: ⚠️ Not financial advice."
}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model:      env.AI_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        system,
        messages:   [{ role: 'user', content: `Analyse this week's most impactful global crisis and its Sri Lanka chain reaction. Today: ${today}. Return ONLY the JSON object.` }],
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('Claude API error:', r.status, errText);
      return errRes(`Claude API ${r.status}`, env, r.status);
    }

    const d = await r.json();
    const rawText = d.content?.[0]?.text || '';

    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('JSON parse failed. Raw text length:', rawText.length);
      console.error('Parse error:', parseErr.message);
      // Return a fallback error with raw text for debugging
      return errRes(`JSON parse failed: ${parseErr.message}`, env, 500);
    }

    const result = {
      ...parsed,
      updatedAt: Date.now(),
      generatedBy: d.model,
    };

    await kvSet(env.CSE_KV, CACHE_KEY, result, CACHE_TTL);

    return okRes({ source: 'live', ...result }, env);

  } catch (e) {
    console.error('Crisis handler error:', e.message);

    // Try to serve stale cache on error
    const stale = await kvGet(env.CSE_KV, CACHE_KEY);
    if (stale) return okRes({ source: 'stale', ...stale }, env);

    return errRes(`Crisis Radar error: ${e.message}`, env);
  }
}

// ═══════════════════════════════════════════════════
//  ADMIN + CRON
// ═══════════════════════════════════════════════════

async function handleCacheClear(request, env) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return errRes('Unauthorized', env, 401);
  const keys = ['market:v1', 'movers:v1', 'sectors:v1', 'forex:v1', 'news:lk::24', 'news:world:20', 'crisis:v1'];
  await Promise.allSettled(keys.map(k => env.CSE_KV.delete(k)));
  return okRes({ cleared: keys, ts: Date.now() }, env);
}

async function runCron(env) {
  console.log('Cron fired:', new Date().toISOString());
  try {
    const [summary, prices, gainers, losers] = await Promise.all([
      cseFetch('marketSummery'), cseFetch('todaySharePrice'),
      cseFetch('topGainers'),   cseFetch('topLooses'),
    ]);
    const TTL = marketStatus().isOpen ? 90 : 300;
    if (prices) {
      const market = { summary: normaliseSummary(summary), stocks: normaliseStocks(prices), updatedAt: Date.now() };
      await kvSet(env.CSE_KV, 'market:v1', market, TTL);
      await kvSet(env.CSE_KV, 'market:v1:stale', market, 86400);
      console.log(`Cron OK: ${market.stocks.length} stocks, ASPI ${market.summary.aspi}`);
    }
    if (gainers || losers) {
      await kvSet(env.CSE_KV, 'movers:v1', { gainers: normaliseMover(gainers), losers: normaliseMover(losers), active: [], updatedAt: Date.now() }, 120);
    }
    const slArticles = await fetchFeeds(SL_FEEDS, 24);
    if (slArticles.length) {
      await kvSet(env.CSE_KV, 'news:lk::24', { articles: slArticles, total: slArticles.length, updatedAt: Date.now() }, 180);
    }
    const forex = await fetchForexFree();
    if (forex) await kvSet(env.CSE_KV, 'forex:v1', { ...forex, updatedAt: Date.now() }, 300);
  } catch (e) {
    console.error('Cron error:', e.message);
  }
}

// ═══════════════════════════════════════════════════
//  MAIN HANDLER
// ═══════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });

    try {
      if (path === '/api/health')                           return okRes({ service: 'CSE Pulse Worker', version: '4.1.0', ts: Date.now() }, env);
      if (path === '/api/status')                           return okRes({ ...marketStatus(), timestamp: new Date().toISOString() }, env);
      if (path === '/api/market'    && method === 'GET')    return handleMarket(env);
      if (path === '/api/movers'    && method === 'GET')    return handleMovers(env);
      if (path === '/api/sectors'   && method === 'GET')    return handleSectors(env);
      if (path === '/api/forex'     && method === 'GET')    return handleForex(env);
      if (path === '/api/news'      && method === 'GET')    return handleNews(url, env);
      if (path === '/api/worldnews' && method === 'GET')    return handleWorldNews(url, env);
      if (path === '/api/stocksense'&& method === 'POST')   return handleStockSense(request, env);
      if (path === '/api/crisis'    && method === 'POST')   return handleCrisis(request, env);  // ← NEW
      if (path === '/api/cache/clear')                      return handleCacheClear(request, env);

      return errRes(`Not found: ${method} ${path}`, env, 404);
    } catch (e) {
      console.error('Unhandled:', e.message);
      return errRes(`Internal error: ${e.message}`, env);
    }
  },

  async scheduled(event, env) {
    await runCron(env);
  },
};
