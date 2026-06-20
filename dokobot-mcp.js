// dokobot-mcp v3.0 — 纯搜索：返回原始 SERP，模型自己选链接用 read_url 追读
const { execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const log = (tag, msg) => process.stderr.write(`[MCP|${tag}] ${msg}\n`);

// 跨平台查找 dokobot CLI
function findDokobotCli() {
  try {
    const npmRoot = require('child_process').execSync(
      process.platform === 'win32' ? 'npm.cmd root -g' : 'npm root -g',
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    const candidate = path.join(npmRoot, '@dokobot', 'cli', 'dist', 'cli', 'bin', 'dokobot.js');
    if (fs.existsSync(candidate)) return { js: candidate, dir: npmRoot };
  } catch {}
  return { js: null, dir: null };
}

const cliInfo = findDokobotCli();
const CLI_JS = cliInfo.js;
const HAS_CLI_JS = !!CLI_JS;
const NPM_DIR = cliInfo.dir || '';
const PATH_SEP = process.platform === 'win32' ? ';' : ':';
const ENV = NPM_DIR
  ? { ...process.env, PATH: process.env.PATH + PATH_SEP + NPM_DIR }
  : process.env;

const ENGINES = {
  google: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  bing: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  baidu: q => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
  duckduckgo: q => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
  sogou: q => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`
};
const ZH_ENGINES = ['google', 'bing', 'baidu'];
const EN_ENGINES = ['google', 'bing', 'duckduckgo'];
const isZh = q => /[一-鿿]/.test(q);

// ---------- 并发池：限 4 并发 ----------
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

// ---------- 缓存 ----------
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

// ---------- 读取 ----------
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
      // 跨平台：从 PATH 找 dokobot 直接 execFile，避开设法问题
      const dokobotCmd = process.platform === 'win32' ? 'dokobot.cmd' : 'dokobot';
      execFile(dokobotCmd, args, opts, cb);
    }
  });
}

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

// ---------- 搜索 ----------
async function searchOne(query, engine, label) {
  const r = await fetchPage(ENGINES[engine](query), `${label}:${engine}`, { timeoutSec: 20 });
  return { eng: engine, q: query, ok: r.ok && r.text.length > 100, text: r.ok ? r.text : '', reason: r.reason };
}

// ---------- quick_search：搜索并返回原始 SERP ----------
async function quickSearch(args) {
  const query = args.site ? `${args.query} site:${args.site}` : args.query;
  const maxChars = args.max_chars || 8000;
  const engine = args.engine || (isZh(query) ? ZH_ENGINES[0] : EN_ENGINES[0]);

  const r = await searchOne(query, engine, 'serp');
  if (!r.ok) {
    // 兜底
    const fallback = (isZh(query) ? ZH_ENGINES : EN_ENGINES).filter(e => e !== engine);
    for (const fb of fallback.slice(0, 2)) {
      const r2 = await searchOne(query, fb, 'serp');
      if (r2.ok) return `【SERP·${fb}】\n${r2.text.substring(0, maxChars)}`;
    }
    return `【搜索失败】${r.reason}`;
  }
  return `【SERP·${engine}】\n${r.text.substring(0, maxChars)}`;
}

// ---------- deep_research：多引擎并行搜索，返回原始 SERP ----------
async function deepResearch(query, keywords) {
  const queries = (keywords && keywords.length ? keywords : [query]).slice(0, 8);
  let zhIdx = 0, enIdx = 0;
  const assigned = queries.map(q => {
    const pool = isZh(q) ? ZH_ENGINES : EN_ENGINES;
    const i = isZh(q) ? zhIdx++ : enIdx++;
    return { q, eng: pool[i % pool.length] };
  });
  log('DEEP', `${queries.length}串: ${assigned.map(a => a.eng).join(',')}`);

  const serps = await Promise.all(assigned.map(({ q, eng }) => searchOne(q, eng, 'serp')));

  const parts = [];
  for (const s of serps) {
    if (s.ok) {
      parts.push(`【SERP·${s.eng}】"${s.q}"\n${s.text.substring(0, 5000)}`);
    } else {
      parts.push(`【SERP·${s.eng} ✗ 失败】"${s.q}" -> ${s.reason}`);
    }
  }

  const tail = ['\n【执行总结】'];
  serps.forEach(s => tail.push(`  ${s.eng} "${s.q.substring(0, 40)}" -> ${s.ok ? '✓' : '✗ ' + s.reason}`));
  tail.push('\n提示：SERP 中有大量链接，请用 read_url 自行挑选追读。');

  const body = parts.length ? parts.join('\n---\n') : '未搜到有效信息';
  const tailText = tail.join('\n');
  return body.substring(0, 40000 - tailText.length - 2) + tailText;
}

// ---------- MCP 工具定义 ----------
const tools = [
  {
    name: "quick_search",
    description: "搜索并返回原始搜索结果页（SERP）。不会自动读取任何链接，模型自己从 SERP 中挑选感兴趣的 URL 用 read_url 追读。\n\n【搜索质量守则】\n- 拿到 SERP 后先判断结果是否切题，明显跑偏直接换词重搜\n- 默认优先保质量：第一轮结果不理想时，自动换关键词再搜，不反复问用户\n- 多轮仍不佳时坦诚说明，告诉用户搜了几轮结果都不太好，问要不要继续\n- 宁可多搜几轮，不要一轮就放弃\n- 回答时用纯文本简单说明搜索情况，不用 Markdown 格式（不用 ** 、不用标题、不用列表）",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "搜索关键词" },
      engine: { type: "string", enum: Object.keys(ENGINES), description: "（可选）指定引擎，默认按语言自动选" },
      site: { type: "string", description: "（可选）限定网站" },
      max_chars: { type: "number", default: 8000 }
    }, required: ["query"] }
  },
  {
    name: "deep_research",
    description: `多引擎并行深度搜索。keywords 传 3-8 个搜索串（中英文分开），自动分配引擎并行搜。
返回所有原始 SERP，不自动读页面，模型自己选 URL 用 read_url 追读。

【搜索质量守则】
- 拿到 SERP 后先判断每条结果是否切题，明显跑偏的串直接换词重搜
- 默认优先保质量：第一轮结果不理想时，自动换关键词再搜，不反复问用户
- 多轮仍不佳时坦诚说明，告诉用户搜了几轮结果都不太好，问要不要继续
- 宁可多搜几轮，不要一轮就放弃
- 回答时用纯文本简单说明搜索情况，不用 Markdown 格式（不用 ** 、不用标题、不用列表）`,
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "用户原始问题" },
      keywords: { type: "array", items: { type: "string" }, description: "搜索串列表，3-8个，多角度中英分开" }
    }, required: ["query", "keywords"] }
  },
  {
    name: "read_url",
    description: "读取指定网页内容。从 SERP 中挑选感兴趣的链接后调用。支持视频页（标题、简介、评论）。screens 控制读取深度。",
    inputSchema: { type: "object", properties: {
      url: { type: "string" },
      screens: { type: "number", description: "（可选）读取屏数，长页面可设 4-8" }
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
log('BOOT', 'dokobot-mcp v3.0 启动 (纯搜索模式)');

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    switch (msg.method) {
      case 'initialize':
        respond(msg.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "dokobot-mcp", version: "3.0.0" } });
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
          text = await deepResearch(args.query, args.keywords);
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
