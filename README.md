# dokobot-mcp-server

Dokobot MCP 服务器 - 为 AI 代理提供真实浏览器的并行网页搜索能力

> **注意**：本项目是对 [@dokobot/cli](https://github.com/dokobot/dokobot) 的 MCP 服务器封装。Dokobot CLI 工具由 [Dokobot](https://dokobot.ai) 团队开发和维护。

## 特性

- 智能搜索引擎路由：中文查询走 Google/Bing/Baidu，英文查询走 Google/Bing/DuckDuckGo
- 真并行搜索：多个搜索串同时执行，自动分配引擎
- URL 评分排序：跨引擎共识 + SERP 位置 + 权威域名加成
- 失败自动递补：页面读取失败自动尝试下一个候选
- 5分钟缓存：避免重复请求同一页面
- 并发限制：最多 4 个浏览器标签页并发

## 前置要求

1. Node.js >= 18
2. [@dokobot/cli](https://www.npmjs.com/package/@dokobot/cli) 全局安装
   ```bash
   npm install -g @dokobot/cli
   ```
3. Chrome 浏览器 + Dokobot 扩展
4. 本地 bridge 已安装
   ```bash
   dokobot install-bridge
   ```

## 安装

```bash
npm install -g dokobot-mcp-server
```

## 在 Astrbot 中使用

编辑 `~/.astrbot/data/mcp_server.json`：

```json
{
  "mcpServers": {
    "dokobot": {
      "command": "node",
      "args": ["/path/to/global/node_modules/dokobot-mcp-server/dokobot-mcp.js"],
      "env": {}
    }
  }
}
```

或者使用 npx（不需要全局安装）：

```json
{
  "mcpServers": {
    "dokobot": {
      "command": "npx",
      "args": ["dokobot-mcp-server"],
      "env": {}
    }
  }
}
```

重启 Astrbot，MCP 工具即可使用。

## MCP 工具列表

### 1. `quick_search`
轻量搜索，默认读取 2 个最有价值的页面

```javascript
{
  "query": "特朗普 2026 最新消息",
  "engine": "google",  // 可选：google/bing/baidu/duckduckgo/sogou
  "site": "bbc.com",   // 可选：限定网站
  "read_pages": 2,     // 0-4，0=只看搜索结果页
  "max_chars": 8000
}
```

### 2. `deep_research`
深度搜索，多个搜索串并行 + 自动挑选最有价值页面深读

```javascript
{
  "query": "特朗普访华",
  "keywords": [
    "特朗普 访华 2026 中美 关系 最新 关税 贸易 会谈 成果 外交部 声明",
    "Trump China Xi meeting trade visit tariff policy 2026",
    "中美 高层 会晤 半导体 芯片 出口 管制 实体清单 反制"
  ],
  "read_pages": 4  // 0-8
}
```

### 3. `read_url`
读取指定网页（支持 B站/YouTube 视频页）

```javascript
{
  "url": "https://example.com/article",
  "screens": 4  // 可选：长页面可设 4-8
}
```

## 工作原理

1. **引擎路由**：检测查询语言，自动分配最擅长的引擎
2. **并行搜索**：多个搜索串同时执行，最多 4 并发
3. **URL 评分**：
   - SERP 位置权重（越靠前越高）
   - 跨引擎共识（多个引擎都返回的加分）
   - 权威域名加成（Wikipedia/GitHub/知乎等）
4. **失败递补**：页面读取失败自动尝试下一个候选
5. **缓存优化**：同一 URL 5 分钟内复用缓存

## 配置说明

服务器会自动查找 `@dokobot/cli`：
- 优先使用：`C:\Users\{用户}\AppData\Roaming\npm\node_modules\@dokobot\cli\dist\cli\bin\dokobot.js`
- 兜底使用：PATH 中的 `dokobot` 命令

## 许可证

MIT
