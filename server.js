/**
 * 零依赖静态服务器 + 检查 API。
 * 浏览器直接以 ES Module 方式加载 src/core，服务端仅负责托管与 JSON 接口。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ORIGINALS, TIMELINE_EVENTS, REELS } from './src/core/data.js';
import { FAULT_LIBRARY, buildFaultyProxies, defaultEnabledFaultIds } from './src/core/faults.js';
import { runConsistencyCheck } from './src/core/checker.js';
import { buildMappingRows, toCSV, toJSON } from './src/core/mapping.js';

const root = dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
};

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    return sendJson(res, 200, {
      reels: REELS,
      originals: ORIGINALS,
      timelineEvents: TIMELINE_EVENTS,
      faultLibrary: FAULT_LIBRARY,
      defaultFaultIds: defaultEnabledFaultIds(),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/check') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { error: '请求体不是合法 JSON' });
    }
    const faultIds = Array.isArray(body.faultIds) ? body.faultIds : [];
    const { proxies, appliedFaultIds } = buildFaultyProxies(faultIds);
    const report = runConsistencyCheck(ORIGINALS, proxies, TIMELINE_EVENTS, body.tolerances);
    return sendJson(res, 200, { report, proxies, appliedFaultIds });
  }

  if (req.method === 'POST' && url.pathname === '/api/export') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const { proxies } = buildFaultyProxies(Array.isArray(body.faultIds) ? body.faultIds : []);
    const report = runConsistencyCheck(ORIGINALS, proxies, TIMELINE_EVENTS);
    const rows = buildMappingRows(report);
    const format = body.format === 'json' ? 'json' : 'csv';
    const content = format === 'json' ? toJSON(report, rows) : toCSV(rows);
    res.writeHead(200, {
      'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="proxy-mapping-pre-conform.${format}"`,
    });
    return res.end(content);
  }

  return sendJson(res, 404, { error: '未知接口' });
}

async function handleStatic(res, pathname) {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(root, safePath === '/' ? 'web/index.html' : safePath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => sendJson(res, 500, { error: String(err) }));
  } else {
    handleStatic(res, url.pathname);
  }
});

const port = Number(process.env.PORT) || 5173;
server.listen(port, () => {
  console.log(`代理媒体一致性检查器已启动: http://localhost:${port}`);
});
