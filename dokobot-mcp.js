// dokobot-mcp v2.0 — 真并行 + 引擎按语言路由 + URL 评分挑选 + 失败递补
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
// 中文查询和英文查询分别走擅长的引擎，顺序即兜底顺序
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
      // 兜底：双引号包参数（cmd 不认单引号），引号转成 %22 防注入
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
// 评分 = SERP 位置权重(每个引擎内越靠前越高) + 跨引擎共识 + 权威域名加成，同域只留最高分
const AUTHORITY = /wikipedia\.org|baike\.baidu\.com|github\.com|stackoverflow\.com|zhihu\.com|moegirl\.org|biligame\.com|huijiwiki\.com|fandom\.com|linux\.do/;
// 引擎的结果跳转链：浏览器打开会 302 到真实页面，必须保留
const REDIRECT_LINK = /baidu\.com\/link\?url=|sogou\.com\/link\?url=|bing\.com\/ck\/a/;
// 垃圾链接特征：广告、导航、登录等无内容价值的页面
const JUNK_PATTERN = /\/(privacy|terms|about|contact|sitemap|rss|feed|tag\/|tags\/|category\/|author\/|page\/\d+|search\?|login|signin|signup|register|oauth|callback)/;
const AD_DOMAIN = /doubleclick|googleads|adservice|adsystem|ad\d*\.|ads\./;
function normalizeUrl(u) {
  // duckduckgo 的跳转链可以直接解出真实地址
  try {
    const url = new URL(u);
    if (url.hostname.includes('duckduckgo.com') && url.searchParams.get('uddg')) {
      return decodeURIComponent(url.searchParams.get('uddg'));
    }
  } catch { /* 保持原样 */ }
  return u;
}
function extractUrls(serpText) {
  const seen = new Map(); // url -> 首次出现的序号
  let order = 0;
  for (const m of serpText.matchAll(/https?:\/\/[^\s\[\]\)\}<>"']+/g)) {
    let u = normalizeUrl(m[0].replace(/[\]}\)"'<>.,;]+$/, ''));
    let host;
    try { host = new URL(u).hostname; } catch { continue; }
    const isRedirect = REDIRECT_LINK.test(u);
    // 跳过搜索引擎自己的链接
    if (ENGINE_HOSTS.test(host) && !isRedirect) continue;
    // 跳过明显的垃圾链接
    if (!isRedirect && JUNK_PATTERN.test(u)) continue;
    // 跳过广告追踪链接
    if (AD_DOMAIN.test(host)) continue;
    if (u.length < 15) continue;
    if (!seen.has(u)) seen.set(u, order++);
  }
  return seen;
}

function rankCandidates(serpResults) {
  // serpResults: [{eng, text}]
  const score = new Map(); // url -> {score, engines}
  for (const { text } of serpResults) {
    const urls = extractUrls(text);
    for (const [u, pos] of urls) {
      const item = score.get(u) || { score: 0, engines: 0 };
      item.score += 1 / (pos + 2);       // 位置权重
      item.engines += 1;
      score.set(u, item);
    }
  }
  const ranked = [];
  for (const [u, item] of score) {
    let s = item.score;
    if (item.engines >= 2) s += 0.5;     // 跨引擎共识
    if (AUTHORITY.test(u)) s += 0.3;     // 权威域名

    // 裸域名首页降权（官网首页通常内容少）
    try {
      const url = new URL(u);
      if (url.pathname.length <= 1) s -= 0.6;  // 降权更多
      // 论坛/问答/Wiki 页面加权
      if (/\/(thread|topic|question|qa|wiki|discuss|forum|t\/)/.test(url.pathname)) s += 0.4;
      // 博客/文章页面加权
      if (/\/(post|article|blog|news|archives?)\//.test(url.pathname)) s += 0.3;
    } catch { /* 忽略 */ }

    ranked.push({ url: u, score: s });
  }
  ranked.sort((a, b) => b.score - a.score);
  // 同域去重；跳转链看不出真实域名，按完整 URL 去重
  const byHost = new Set();
  return ranked.filter(({ url }) => {
    const key = REDIRECT_LINK.test(url) ? url : new URL(url).hostname;
    if (byHost.has(key)) return false;
    byHost.add(key);
    return true;
  });
}

// 按候选顺序读页面，失败自动递补，直到拿满 want 个或耗尽
async function readWithRefill(candidates, want, { screens = 0, perPageChars = 5000 } = {}) {
  const results = [];
  const tried = [];
  let idx = 0;
  while (results.length < want && idx < candidates.length && tried.length < want * 2 + 2) {
    const batch = candidates.slice(idx, idx + (want - results.length));
    idx += batch.length;
    const fetched = await Promise.all(
      batch.map(c => fetchPage(c.url, '页面', { screens }).then(r => ({ ...r, url: c.url })))
    );
    for (const r of fetched) {
      tried.push({ url: r.url, ok: r.ok && r.text.length > 200, reason: r.reason });
      if (r.ok && r.text.length > 200) results.push({ url: r.url, text: r.text.substring(0, perPageChars) });
    }
  }
  return { results, tried, unread: candidates.slice(idx).map(c => c.url) };
}

// ---------- 搜索主逻辑 ----------
async function searchOne(query, engine, label) {
  const r = await fetchPage(ENGINES[engine](query), `${label}:${engine}`);
  return { eng: engine, q: query, ok: r.ok && r.text.length > 100, text: r.ok ? r.text : '', reason: r.reason };
}

// 单串搜索 + 同语言兜底链
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

async function deepResearch(query, keywords, readPages) {
  const n = Math.min(Math.max(readPages || 4, 0), 8);
  const queries = (keywords && keywords.length ? keywords : [query]).slice(0, 8);
  // 按语言路由：中文串走中文引擎池轮转，英文串走英文池轮转
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
  const { results, tried, unread } = n > 0
    ? await readWithRefill(candidates, n, { screens: 4, perPageChars: 7000 })
    : { results: [], tried: [], unread: candidates.map(c => c.url) };

  const parts = [];
  for (const s of okSerps) parts.push(`【SERP·${s.eng}】${s.q.substring(0, 60)}\n${s.text.substring(0, 1500)}`);

  // 明确标注成功读取的页面
  if (results.length > 0) {
    parts.push(`\n【成功读取 ${results.length} 个页面】`);
    results.forEach((r, i) => parts.push(`【正文${i + 1}】${r.url}\n${r.text}`));
  }

  // 结构化尾部：让模型自己决定要不要二轮
  const tail = ['【执行过程总结】'];
  serps.forEach(s => tail.push(`  搜索 ${s.eng} "${s.q.substring(0, 50)}" -> ${s.ok ? '✓ 成功' : '✗ 失败:' + s.reason}`));

  const successCount = tried.filter(t => t.ok).length;
  const failCount = tried.filter(t => !t.ok).length;
  tail.push(`\n【页面读取统计】成功 ${successCount}/${tried.length}，失败 ${failCount}`);
  tried.forEach(t => tail.push(`  ${t.ok ? '✓' : '✗'} ${t.url.substring(0, 70)} ${t.ok ? '' : '-> ' + (t.reason || '内容过短')}`));

  if (unread.length) {
    tail.push('\n【候选未读，需要更多信息可用 read_url 继续】');
    unread.slice(0, 5).forEach(u => tail.push(`  ${u}`));
  }
  const failedQs = serps.filter(s => !s.ok).map(s => s.q);
  if (failedQs.length) tail.push(`\n【未覆盖角度（搜索失败，可换词重试）】${failedQs.map(q => q.substring(0, 40)).join(' | ')}`);

  if (results.length === 0) {
    tail.push('\n⚠ 警告：本次搜索未成功读取任何页面内容，仅获得搜索结果页，请换词重试或读取【候选未读】');
  }

  const body = parts.length ? parts.join('\n---\n') : '未搜到有效信息';
  const tailText = tail.join('\n');
  // 正文单独限长，结构化尾部永远完整保留（它是模型决定二轮的依据）
  return body.substring(0, 32000 - tailText.length - 2) + '\n\n' + tailText;
}

async function quickSearch(args) {
  const query = args.site ? `${args.query} site:${args.site}` : args.query;
  const maxChars = args.max_chars || 8000;
  const readN = args.read_pages === undefined ? 2 : Math.min(args.read_pages, 4);
  const serp = await searchWithFallback(query, args.engine);
  if (!serp.ok) return `【搜索失败】${serp.reason}，换关键词或稍后再试`;
  let out = `【SERP·${serp.eng}】\n${serp.text.substring(0, readN > 0 ? 2000 : maxChars)}`;

  if (readN > 0) {
    const candidates = rankCandidates([serp]);
    const { results, tried } = await readWithRefill(candidates, readN, { perPageChars: 4000 });

    if (results.length > 0) {
      out += `\n\n【成功读取 ${results.length} 个页面】`;
      results.forEach((r, i) => { out += `\n\n【正文${i + 1}】${r.url}\n${r.text}`; });
    }

    // 添加统计信息
    const successCount = tried.filter(t => t.ok).length;
    const failCount = tried.filter(t => !t.ok).length;
    out += `\n\n【读取统计】成功 ${successCount}/${tried.length}，失败 ${failCount}`;
    if (results.length === 0) {
      out += '\n⚠ 警告：未成功读取任何页面，仅获得搜索结果，建议换词重试';
    }
  }

  return out.substring(0, maxChars);
}

// ---------- MCP 工具定义 ----------
const tools = [
  {
    name: "quick_search",
    description: "轻量搜索。默认Google，失败自动换Bing/百度，搜完自动读2个最有价值的页面。\n查询串建议塞10-20个关键词多角度覆盖。可用site限定网站。设置read_pages=0只看搜索结果页。\n适合快速查证单个事实。需要靠谱结论、对比考证、或这次结果不充分时，改用deep_research多串并行深搜。",
    inputSchema: { type: "object", properties: {
      query: { type: "string" },
      engine: { type: "string", enum: Object.keys(ENGINES), description: "（可选）指定引擎，默认按语言自动选" },
      site: { type: "string", description: "（可选）限定网站，如 bbc.com" },
      max_chars: { type: "number", default: 8000 },
      read_pages: { type: "number", default: 2, description: "自动读取页面数，0=只看搜索结果，最多4" }
    }, required: ["query"] }
  },
  {
    name: "deep_research",
    description: `深度搜索。用户问新闻、实时信息、事实考证时必须调用，不能自己编。
keywords 必传，每个元素是一个完整搜索串【15-30个词，多角度】，中文串和英文串分开写，会自动分配引擎并行搜。
例如「特朗普访华」传:
  ["特朗普 访华 2026 中美 关系 最新 关税 贸易 会谈 成果 外交部 声明",
   "Trump China Xi meeting trade visit tariff policy 2026",
   "中美 高层 会晤 半导体 芯片 出口 管制 实体清单 反制"]
搜完自动按「跨引擎共识+排名+权威域名」挑最有价值的页面深读（含失败递补）。

【下结论前必须做到】
1. 交叉验证：至少2个独立来源一致才可采信；只有单一来源时明确说"仅单一来源"
2. 来源冲突时优先官方/权威来源，并向用户说明存在分歧
3. 信息不足、来源单一或【未覆盖角度】有失败项时，换关键词再调一次，或用 read_url 追读【候选未读】里的链接
4. 注意信息时效，留意页面日期，旧消息别当新消息说

⚠ 关键：返回内容末尾有【执行过程总结】和【页面读取统计】，显示了实际成功/失败的页面数。
如果【成功读取 0 个页面】或统计显示全部失败，则你只有搜索结果页，没有实际内容，必须换词重试或声明信息不足。
不要基于失败的搜索结果编造答案。`,
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "用户的原始问题" },
      keywords: { type: "array", items: { type: "string" }, description: "搜索串列表，3-8个，多角度中英分开" },
      read_pages: { type: "number", default: 4, description: "深读页面数，最多8" }
    }, required: ["query", "keywords"] }
  },
  {
    name: "read_url",
    description: "读取指定网页内容。支持B站/YouTube等视频页（标题、简介、热门评论）。screens 控制读取深度，长文可调大（默认自动）。",
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
log('BOOT', `dokobot-mcp v2.0 启动 (cli_js=${HAS_CLI_JS})`);

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    switch (msg.method) {
      case 'initialize':
        respond(msg.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "dokobot-mcp", version: "2.0.0" } });
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
          text = await deepResearch(args.query, args.keywords, args.read_pages);
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
