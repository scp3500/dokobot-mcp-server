// dokobot-mcp v2.1 — 真并行 + 引擎按语言路由 + URL 评分挑选 + 失败递补 + 模型自主筛选
const { execFile, exec } = require('child_process');
const fs = require('fs');
const readline = require('readline');

const log = (tag, msg) => process.stderr.write(`[MCP|${tag}] ${msg}\n`);

const NPM_DIR = 'C:\\Users\\33795\\AppData\\Roaming\\npm';
const CLI_JS = NPM_DIR + '\\node_modules\\@dokobot\\cli\\dist\\cli\\bin\\dokobot.js';
const HAS_CLI_JS = fs.existsSync(CLI_JS);
const ENV = { ...process.env, PATH: process.env.PATH + ';' + NPM_DIR };

const ENGINES = {
  google: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  bing: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  baidu: q => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
  duckduckgo: q => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
  sogou: q => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`
};
const ENGINE_HOSTS = /(^|\.)(google|bing|baidu|duckduckgo|sogou)\./;
const ZH_ENGINES = ['google', 'bing', 'baidu'];
const EN_ENGINES = ['google', 'bing', 'duckduckgo'];
const isZh = q => /[一-鿿]/.test(q);

// ---------- 并发池：dokobot 每次读取占一个浏览器标签页，限 4 并发 ----------
function pLimit(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve } = queue.shift();
    fn().then(resolve, resolve).finally(() => { active--; next(); });
  };
  return fn => new Promise(resolve => { queue.push({ fn, resolve }); next(); });
}
const limit = pLimit(4);

// ---------- 缓存：URL -> 文本，5 分钟 ----------
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function getCache(url) {
  const hit = cache.get(url);
  return hit && Date.now() - hit.time < CACHE_TTL ? hit.text : null;
}
function setCache(url, text) {
  cache.set(url, { text, time: Date.now() });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

function classifyError(msg) {
  const m = msg || '';
  if (/ETIMEDOUT|timed out|ERR_SCRIPT_EXECUTION_TIMEOUT/i.test(m)) return '超时';
  if (/ENOTFOUND/.test(m)) return 'DNS解析失败';
  if (/ECONNREFUSED/.test(m)) return '连接被拒绝(本地bridge未启动?)';
  if (/ECONNRESET/.test(m)) return '连接重置';
  if (/429/.test(m)) return '请求过频(429)';
  if (/40[34]/.test(m)) return '页面拒绝访问(403/404)';
  if (/50[23]|5\d\d/.test(m)) return '服务端错误(5xx)';
  if (/maxBuffer/.test(m)) return '响应过大';
  return '错误:' + m.replace(/\n/g, ' ').substring(0, 80);
}

// ---------- 读取：优先直接 node 调 CLI 的 JS 入口，绕开 cmd 引号问题 ----------
function dokoExec(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cb = (err, stdout) => {
      if (err) return reject(err);
      resolve(Buffer.isBuffer(stdout) ? stdout.toString('utf-8') : String(stdout));
    };
    const opts = { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer', env: ENV };
    if (HAS_CLI_JS) {
      execFile(process.execPath, [CLI_JS, ...args], opts, cb);
    } else {
      const quoted = args.map(a => `"${String(a).replace(/"/g, '%22')}"`).join(' ');
      exec(`dokobot ${quoted}`, opts, cb);
    }
  });
}

// fetchPage -> { ok, text, reason }
async function fetchPage(url, label, { screens = 0, timeoutSec = 25 } = {}) {
  const cached = getCache(url);
  if (cached) { log('CACHE', label); return { ok: true, text: cached }; }
  const args = ['read', '--local', '--timeout', String(timeoutSec), url];
  if (screens > 0) args.splice(2, 0, '--screens', String(screens));
  const start = Date.now();
  return limit(async () => {
    try {
      const raw = await dokoExec(args, (timeoutSec + 10) * 1000);
      const text = raw.replace(/�/g, '').trim();
      if (!text) return { ok: false, reason: '空内容' };
      log('OK', `${label} ${text.length}字符 ${Date.now() - start}ms`);
      setCache(url, text);
      return { ok: true, text };
    } catch (e) {
      const reason = classifyError(e.message);
      log('ERR', `${label} ${reason} ${Date.now() - start}ms`);
      return { ok: false, reason };
    }
  });
}

// ---------- SERP 解析与 URL 评分 ----------
// 排名完全由 SERP 位置 + 跨引擎共识决定，不预设权威域名偏好
const REDIRECT_LINK = /baidu\.com\/link\?url=|sogou\.com\/link\?url=|bing\.com\/ck\/a/;
const JUNK_PATTERN = /\/(privacy|terms|about|contact|sitemap|rss|feed|tag\/|tags\/|category\/|author\/|page\/\d+|search\?|login|signin|signup|register|oauth|callback)/;
const AD_DOMAIN = /doubleclick|googleads|adservice|adsystem|ad\d*\.|ads\./;
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    if (url.hostname.includes('duckduckgo.com') && url.searchParams.get('uddg')) {
      return decodeURIComponent(url.searchParams.get('uddg'));
    }
  } catch { /* 保持原样 */ }
  return u;
}
function extractUrls(serpText) {
  const seen = new Map();
  let order = 0;
  for (const m of serpText.matchAll(/https?:\/\/[^\s\[\]\)\}<>"']+/g)) {
    let u = normalizeUrl(m[0].replace(/[\]}\)"'<>.,;]+$/, ''));
    let host;
    try { host = new URL(u).hostname; } catch { continue; }
    const isRedirect = REDIRECT_LINK.test(u);
    if (ENGINE_HOSTS.test(host) && !isRedirect) continue;
    if (!isRedirect && JUNK_PATTERN.test(u)) continue;
    if (AD_DOMAIN.test(host)) continue;
    if (u.length < 15) continue;
    if (!seen.has(u)) seen.set(u, order++);
  }
  return seen;
}

function rankCandidates(serpResults) {
  const score = new Map();
  for (const { text } of serpResults) {
    const urls = extractUrls(text);
    for (const [u, pos] of urls) {
      const item = score.get(u) || { score: 0, engines: 0 };
      item.score += 1 / (pos + 2);
      item.engines += 1;
      score.set(u, item);
    }
  }
  const ranked = [];
  for (const [u, item] of score) {
    let s = item.score;
    if (item.engines >= 2) s += 0.5;
    // 裸域名首页降权
    try {
      const url = new URL(u);
      if (url.pathname.length <= 1) s -= 0.6;
    } catch { /* 忽略 */ }
    ranked.push({ url: u, score: s });
  }
  ranked.sort((a, b) => b.score - a.score);
  const byHost = new Set();
  return ranked.filter(({ url }) => {
    const key = REDIRECT_LINK.test(url) ? url : new URL(url).hostname;
    if (byHost.has(key)) return false;
    byHost.add(key);
    return true;
  });
}

// 按候选顺序读页面，urlFilter 让模型决定只读哪些
async function readWithRefill(candidates, want, { screens = 0, perPageChars = 5000, urlFilter = null } = {}) {
  const results = [];
  const tried = [];
  const filterRe = urlFilter ? new RegExp(urlFilter) : null;
  const eligible = filterRe ? candidates.filter(c => filterRe.test(c.url)) : candidates;
  const skipped = filterRe ? candidates.filter(c => !filterRe.test(c.url)).map(c => c.url) : [];
  let idx = 0;
  while (results.length < want && idx < eligible.length && tried.length < want * 2 + 2) {
    const batch = eligible.slice(idx, idx + (want - results.length));
    idx += batch.length;
    const fetched = await Promise.all(
      batch.map(c => fetchPage(c.url, '页面', { screens }).then(r => ({ ...r, url: c.url })))
    );
    for (const r of fetched) {
      tried.push({ url: r.url, ok: r.ok && r.text.length > 200, reason: r.reason });
      if (r.ok && r.text.length > 200) results.push({ url: r.url, text: r.text.substring(0, perPageChars) });
    }
  }
  return { results, tried, skipped, unread: eligible.slice(idx).map(c => c.url) };
}

// ---------- 搜索主逻辑 ----------
async function searchOne(query, engine, label) {
  const r = await fetchPage(ENGINES[engine](query), `${label}:${engine}`);
  return { eng: engine, q: query, ok: r.ok && r.text.length > 100, text: r.ok ? r.text : '', reason: r.reason };
}

async function searchWithFallback(query, preferred) {
  const chain = preferred
    ? [preferred, ...(isZh(query) ? ZH_ENGINES : EN_ENGINES).filter(e => e !== preferred)]
    : (isZh(query) ? ZH_ENGINES : EN_ENGINES);
  for (const eng of chain.slice(0, 3)) {
    const r = await searchOne(query, eng, 'serp');
    if (r.ok) return r;
  }
  return { eng: chain[0], q: query, ok: false, text: '', reason: '所有引擎均失败' };
}

async function deepResearch(query, keywords, readPages, urlFilter) {
  const n = Math.min(Math.max(readPages || 4, 0), 8);
  const queries = (keywords && keywords.length ? keywords : [query]).slice(0, 8);
  let zhIdx = 0, enIdx = 0;
  const assigned = queries.map(q => {
    const pool = isZh(q) ? ZH_ENGINES : EN_ENGINES;
    const i = isZh(q) ? zhIdx++ : enIdx++;
    return { q, eng: pool[i % pool.length] };
  });
  log('DEEP', `${queries.length}串: ${assigned.map(a => a.eng).join(',')}`);

  const serps = await Promise.all(assigned.map(({ q, eng }) => searchOne(q, eng, 'serp')));
  const okSerps = serps.filter(s => s.ok);
  const candidates = rankCandidates(okSerps);
  const { results, tried, skipped, unread } = n > 0
    ? await readWithRefill(candidates, n, { screens: 4, perPageChars: 7000, urlFilter })
    : { results: [], tried: [], skipped: [], unread: candidates.map(c => c.url) };

  const parts = [];
  for (const s of okSerps) parts.push(`【SERP·${s.eng}】${s.q.substring(0, 60)}\n${s.text.substring(0, 1500)}`);

  if (results.length > 0) {
    parts.push(`\n【成功读取 ${results.length} 个页面】`);
    results.forEach((r, i) => parts.push(`【正文${i + 1}】${r.url}\n${r.text}`));
  }

  const tail = ['【执行过程总结】'];
  serps.forEach(s => tail.push(`  搜索 ${s.eng} "${s.q.substring(0, 50)}" -> ${s.ok ? '✓ 成功' : '✗ 失败:' + s.reason}`));

  const successCount = tried.filter(t => t.ok).length;
  const failCount = tried.filter(t => !t.ok).length;
  tail.push(`\n【页面读取统计】成功 ${successCount}/${tried.length}，失败 ${failCount}`);
  tried.forEach(t => tail.push(`  ${t.ok ? '✓' : '✗'} ${t.url.substring(0, 70)} ${t.ok ? '' : '-> ' + (t.reason || '内容过短')}`));

  // 完整候选排名列表（带分数），模型自主判断追读哪个
  if (candidates.length > 0) {
    tail.push(`\n【候选排名（共 ${candidates.length} 条，按 SERP 位置+跨引擎共识评分）】`);
    candidates.slice(0, 30).forEach(c => tail.push(`  ${c.score.toFixed(2)} ${c.url}`));
  }

  if (skipped.length) {
    tail.push(`\n【被 url_filter 跳过的候选】`);
    skipped.slice(0, 10).forEach(u => tail.push(`  ${u}`));
  }

  if (unread.length) {
    tail.push('\n【候选未读，需要更多信息可用 read_url 继续】');
    unread.slice(0, 10).forEach(u => tail.push(`  ${u}`));
  }

  const failedQs = serps.filter(s => !s.ok).map(s => s.q);
  if (failedQs.length) tail.push(`\n【未覆盖角度（搜索失败，可换词重试）】${failedQs.map(q => q.substring(0, 40)).join(' | ')}`);

  if (results.length === 0 && n > 0) {
    tail.push('\n【警告】本次搜索未成功读取任何页面内容，仅获得搜索结果页，请换词重试或读取【候选未读】');
  }

  const body = parts.length ? parts.join('\n---\n') : '未搜到有效信息';
  const tailText = tail.join('\n');
  return body.substring(0, 32000 - tailText.length - 2) + '\n\n' + tailText;
}

async function quickSearch(args) {
  const query = args.site ? `${args.query} site:${args.site}` : args.query;
  const maxChars = args.max_chars || 8000;
  const readN = args.read_pages === undefined ? 2 : Math.min(args.read_pages, 4);
  const urlFilter = args.url_filter || null;
  const serp = await searchWithFallback(query, args.engine);
  if (!serp.ok) return `【搜索失败】${serp.reason}，换关键词或稍后再试`;
  let out = `【SERP·${serp.eng}】\n${serp.text.substring(0, readN > 0 ? 2000 : maxChars)}`;

  if (readN > 0) {
    const candidates = rankCandidates([serp]);
    const { results, tried, skipped, unread } = await readWithRefill(candidates, readN, { perPageChars: 4000, urlFilter });

    if (results.length > 0) {
      out += `\n\n【成功读取 ${results.length} 个页面】`;
      results.forEach((r, i) => { out += `\n\n【正文${i + 1}】${r.url}\n${r.text}`; });
    }

    const successCount = tried.filter(t => t.ok).length;
    const failCount = tried.filter(t => !t.ok).length;
    out += `\n\n【读取统计】成功 ${successCount}/${tried.length}，失败 ${failCount}`;

    if (skipped.length) {
      out += `\n\n【被 url_filter 跳过 ${skipped.length} 条】`;
      skipped.slice(0, 5).forEach(u => out += `\n  ${u}`);
    }
    if (unread.length) {
      out += `\n\n【候选未读 ${unread.length} 条，可用 read_url 追读】`;
      unread.slice(0, 5).forEach(u => out += `\n  ${u}`);
    }
    if (results.length === 0) {
      out += '\n【警告】未成功读取任何页面，仅获得搜索结果，建议换词重试';
    }
  }

  return out.substring(0, maxChars);
}

// ---------- MCP 工具定义 ----------
const tools = [
  {
    name: "quick_search",
    description: "轻量搜索。默认Google，失败自动换Bing/百度，搜完自动读最有价值的页面。\n设 read_pages=0 只看搜索结果不自动读，模型从候选列表手选用 read_url 追读。\nurl_filter 传正则筛选只读哪些链接（如 'github.com|stackoverflow.com' ）。",
    inputSchema: { type: "object", properties: {
      query: { type: "string" },
      engine: { type: "string", enum: Object.keys(ENGINES), description: "（可选）指定引擎，默认按语言自动选" },
      site: { type: "string", description: "（可选）限定网站" },
      url_filter: { type: "string", description: "（可选）正则，只自动读取匹配的 URL。留空则全部候选按排名读取" },
      max_chars: { type: "number", default: 8000 },
      read_pages: { type: "number", default: 2, description: "0=不自动读取，模型自行手选。最多4" }
    }, required: ["query"] }
  },
  {
    name: "deep_research",
    description: `深度搜索。keywords 必传，每个元素一个完整搜索串【15-30词，多角度】，中英文分开自动分配引擎并行搜。
搜完按「跨引擎共识+排名」挑页面深读。返回完整候选排名列表（带分数），模型自主判断追读哪个。

【模型的主动权】
- 设 read_pages=0：不自动读任何页面，拿到完整候选列表后自己手选用 read_url 追读
- 设 url_filter：传正则只自动读匹配的链接，其余进跳过列表
- 信息不足时看【候选未读】和【候选排名】，挑链接用 read_url 补读，或换关键词再搜

【下结论前必须做到】
1. 交叉验证：至少2个独立来源一致才可采信；单一来源时明确说明
2. 来源冲突时优先官方/权威来源，并说明存在分歧
3. 信息不足或【成功读取 0 个页面】时，换词重试或声明信息不足，不要编造答案`,
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "用户原始问题" },
      keywords: { type: "array", items: { type: "string" }, description: "搜索串列表，3-8个，多角度中英分开" },
      url_filter: { type: "string", description: "（可选）正则，只自动读取匹配的 URL。留空则全部候选按排名读取" },
      read_pages: { type: "number", default: 4, description: "0=不自动读取，模型自行手选。最多8" }
    }, required: ["query", "keywords"] }
  },
  {
    name: "read_url",
    description: "读取指定网页内容。支持B站/YouTube等视频页（标题、简介、热门评论）。screens 控制读取深度。",
    inputSchema: { type: "object", properties: {
      url: { type: "string" },
      screens: { type: "number", description: "（可选）读取屏数，长页面可设4-8" }
    }, required: ["url"] }
  }
];

// ---------- JSON-RPC ----------
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + '\n');
}
function respondErr(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
log('BOOT', `dokobot-mcp v2.1 启动 (cli_js=${HAS_CLI_JS})`);

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    switch (msg.method) {
      case 'initialize':
        respond(msg.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "dokobot-mcp", version: "2.1.0" } });
        break;
      case 'tools/list':
        respond(msg.id, { tools });
        break;
      case 'tools/call': {
        const name = msg.params?.name;
        const args = msg.params?.arguments || {};
        log('CALL', `${name} ${JSON.stringify(args).substring(0, 120)}`);
        let text;
        if (name === 'quick_search') {
          text = await quickSearch(args);
        } else if (name === 'deep_research') {
          text = await deepResearch(args.query, args.keywords, args.read_pages, args.url_filter);
        } else if (name === 'read_url') {
          const r = await fetchPage(args.url, 'read', { screens: args.screens || 0, timeoutSec: 40 });
          text = r.ok ? r.text.substring(0, 16000) : `【读取失败】${r.reason}`;
        } else {
          respondErr(msg.id, -32602, `未知工具: ${name}`);
          break;
        }
        respond(msg.id, { content: [{ type: "text", text: text || '【无结果】' }] });
        break;
      }
      default:
        if (msg.id !== undefined) respondErr(msg.id, -32601, `未知方法: ${msg.method}`);
    }
  } catch (e) {
    log('FATAL', `${msg.method}: ${e.message}`);
    if (msg.id !== undefined) {
      respond(msg.id, { content: [{ type: "text", text: `【内部错误】${classifyError(e.message)}` }], isError: true });
    }
  }
});
