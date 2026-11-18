import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = fileURLToPath(new URL("./public", import.meta.url));
const port = Number(process.env.PORT || 8080);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".otf": "font/otf",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/") {
    res.writeHead(302, { Location: "/sender.html" });
    res.end();
    return;
  }

  const routes = {
    "/sender": "sender.html",
    "/receiver": "receiver.html",
  };
  const relative = routes[url.pathname] || url.pathname.replace(/^\/+/, "");
  const file = normalize(join(root, relative));
  if (!file.startsWith(root)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    await access(file);
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ server, path: "/signal" });
const rooms = new Map();

function roomClients(room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  return rooms.get(room);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function presence(room) {
  const roles = [...roomClients(room)]
    .filter((ws) => ws.role)
    .map((ws) => ws.role);
  return { type: "presence", roles };
}

wss.on("connection", (ws) => {
  ws.room = "default";
  ws.role = "";
  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "join") {
      if (ws.room) roomClients(ws.room).delete(ws);
      ws.room = String(message.room || "default");
      ws.role = String(message.role || "peer");
      roomClients(ws.room).add(ws);
      for (const peer of roomClients(ws.room)) {
        send(peer, presence(ws.room));
      }
      return;
    }

    if (message.type === "leave") {
      roomClients(ws.room).delete(ws);
      for (const peer of roomClients(ws.room)) send(peer, presence(ws.room));
      ws.role = "";
      return;
    }

    for (const peer of roomClients(ws.room)) {
      if (peer !== ws) send(peer, message);
    }
  });

  ws.on("close", () => {
    roomClients(ws.room).delete(ws);
    for (const peer of roomClients(ws.room)) send(peer, presence(ws.room));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`WebRTC Quality Lab: http://127.0.0.1:${port}`);
  console.log(`Sender:   http://127.0.0.1:${port}/sender.html`);
  console.log(`Receiver: http://127.0.0.1:${port}/receiver.html`);
});
