import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Http3Server, quicheLoaded } from '@fails-components/webtransport';
import { loadStore, saveStore } from './media.js';
import { Streamer } from './streamer.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8787);
const WT_PORT = Number(process.env.WT_PORT ?? 4434);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
};

async function readBody(req) {
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  return Buffer.concat(parts);
}

let store = null;

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/capture') {
      const body = await readBody(req);
      await saveStore(JSON.parse(body.toString('utf8')));
      store = await loadStore();
      console.log(
        `[media] captured: video=${store.video.chunks.length} audio=${store.audio.chunks.length}`
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bytes: body.byteLength }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/cert-hash') {
      const der = await readFile(path.join(ROOT, 'certs/cert.der'));
      const hex = createHash('sha256').update(der).digest('hex');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha256Hex: hex }));
      return;
    }
    if (req.method === 'GET') {
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(ROOT, 'public', path.normalize(urlPath));
      if (!filePath.startsWith(path.join(ROOT, 'public'))) throw new Error('bad path');
      const data = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(data);
      return;
    }
    res.writeHead(405);
    res.end();
  } catch (err) {
    res.writeHead(404);
    res.end(String(err.message ?? err));
  }
});

async function readStreamAll(readable) {
  const reader = readable.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function configForClient(store) {
  const enc = (cfg) =>
    cfg && cfg.description
      ? { ...cfg, description: Buffer.from(cfg.description).toString('base64') }
      : cfg;
  return {
    type: 'config',
    video: { config: enc(store.video.config) },
    audio: { config: enc(store.audio.config) },
  };
}

async function handleSession(session, store) {
  await session.ready;
  if (!store) throw new Error('no media captured yet (run tools/capture.js)');
  const bidiReader = session.incomingBidirectionalStreams.getReader();
  const { value: stream } = await bidiReader.read();
  bidiReader.releaseLock();
  const cfgBytes = await readStreamAll(stream.readable);
  const clientConfig = JSON.parse(new TextDecoder().decode(cfgBytes));
  console.log('[wt] client config:', clientConfig);
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(configForClient(store))));
  const datagramWriter = session.datagrams.createWritable().getWriter();
  const streamer = new Streamer(store, clientConfig, (m) => console.log('[wt]', m));
  streamer.start(datagramWriter, async () => {
    try {
      await writer.write(
        new TextEncoder().encode(
          JSON.stringify({ type: 'end', frames: streamer.sentFrames, chunks: streamer.sentChunks })
        )
      );
      await writer.close();
    } catch (err) {
      console.log('[wt] end notify failed:', err.message);
    }
  });
  session.closed.then(() => streamer.stop()).catch(() => streamer.stop());
}

async function main() {
  await quicheLoaded;
  try {
    store = await loadStore();
    console.log(
      `[media] video chunks=${store.video.chunks.length} audio chunks=${store.audio.chunks.length}`
    );
  } catch {
    console.log('[media] no store yet, waiting for /capture upload');
  }
  const cert = await readFile(path.join(ROOT, 'certs/cert.pem'), 'utf8');
  const privKey = await readFile(path.join(ROOT, 'certs/key.pem'), 'utf8');
  const wtServer = new Http3Server({
    port: WT_PORT,
    host: '127.0.0.1',
    secret: 'wt-media-lab-secret',
    cert,
    privKey,
  });
  wtServer.startServer();
  await wtServer.ready;
  console.log(`[wt] WebTransport listening on https://127.0.0.1:${WT_PORT}/media`);
  (async () => {
    const sessionStream = await wtServer.sessionStream('/media');
    const reader = sessionStream.getReader();
    for (;;) {
      const { done, value: session } = await reader.read();
      if (done) break;
      handleSession(session, store).catch((err) => console.log('[wt] session error:', err));
    }
  })();
  httpServer.listen(HTTP_PORT, () => {
    console.log(`[http] UI on http://127.0.0.1:${HTTP_PORT}/`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
