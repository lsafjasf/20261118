// Minimal zero-dependency static server for the WebCodecs UI.
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { extname, resolve, normalize, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(root, 'public');
const port = Number(process.env.PORT || 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.css': 'text/css; charset=utf-8',
};

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const safePath = normalize(urlPath).replaceAll(sep, '/');
  const relative = safePath === '/' ? '/index.html' : safePath;
  const publicCandidate = resolve(publicDir, `.${relative}`);
  const rootCandidate = resolve(root, `.${relative}`);
  let filePath = rootCandidate;
  if (publicCandidate.startsWith(publicDir)) {
    try {
      await access(publicCandidate);
      filePath = publicCandidate;
    } catch {
      filePath = rootCandidate;
    }
  }
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': types[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => {
  console.log(`serving ${root} at http://localhost:${port}/`);
});
