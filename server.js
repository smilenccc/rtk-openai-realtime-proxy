/**
 * rtk-openai-realtime-proxy - server.js
 *
 * Endpoints:
 *   HTTP  GET  /health   -> "ok"
 *   WS    WSS  /realtime -> proxy to OpenAI Realtime WS
 *
 * Required env:
 *   OPENAI_API_KEY        = "sk-..."
 *
 * Optional env:
 *   OPENAI_REALTIME_URL   = "wss://api.openai.com/v1/realtime?model=gpt-realtime"
 *   PORT                  = (Render provides)
 */

import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = parseInt(process.env.PORT || "10000", 10);

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_REALTIME_URL =
  (process.env.OPENAI_REALTIME_URL || "").trim() ||
  "wss://api.openai.com/v1/realtime?model=gpt-realtime";

if (!OPENAI_API_KEY) {
  console.error("[FATAL] Missing env OPENAI_API_KEY");
  process.exit(1);
}

function now() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(now(), ...args);
}

function err(...args) {
  console.error(now(), ...args);
}

function safeClose(ws, code, reason) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(code, reason);
  } catch {}
}

function safeTerminate(ws) {
  try {
    ws.terminate();
  } catch {}
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url === "/" || url === "/health") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

// Use noServer to handle WS upgrade manually
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (!url.startsWith("/realtime")) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    wss.emit("connection", clientWs, req);
  });
});

wss.on("connection", (clientWs, req) => {
  const path = req.url || "/realtime";
  log("[Client] WS connected:", path);

  // Connect upstream to OpenAI Realtime WS
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      // Important for Realtime beta compatibility
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // When OpenAI handshake fails, ws emits "unexpected-response"
  openaiWs.on("unexpected-response", (_req, res) => {
    err(
      "[OpenAI] unexpected-response:",
      res.statusCode,
      res.statusMessage || ""
    );
    // Close client with 1011 (internal error)
    safeClose(clientWs, 1011, `openai unexpected-response ${res.statusCode}`);
    // Ensure upstream terminates too
    safeTerminate(openaiWs);
  });

  const closeBoth = (code = 1000, reason = "closing") => {
    safeClose(clientWs, code, reason);
    safeClose(openaiWs, code, reason);
    // In case close doesn't happen, terminate
    setTimeout(() => {
      safeTerminate(clientWs);
      safeTerminate(openaiWs);
    }, 1500);
  };

  openaiWs.on("open", () => {
    log("[OpenAI] Connected to OpenAI Realtime");
  });

  openaiWs.on("message", (data, isBinary) => {
    // Upstream -> Client
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on("message", (data, isBinary) => {
    // Client -> Upstream
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(data, { binary: isBinary });
    }
  });

  openaiWs.on("close", (code, reason) => {
    log("[OpenAI] WS closed:", code, reason?.toString() || "");
    closeBoth(1000, "openai closed");
  });

  openaiWs.on("error", (e) => {
    // Common: "Unexpected server response: 401"
    err("[OpenAI] WS error:", e?.message || e);
    closeBoth(1011, "openai error");
  });

  clientWs.on("close", (code, reason) => {
    log("[Client] WS closed:", code, reason?.toString() || "");
    closeBoth(1000, "client closed");
  });

  clientWs.on("error", (e) => {
    err("[Client] WS error:", e?.message || e);
    closeBoth(1011, "client error");
  });

  // Ping to keep intermediate proxies alive (does not prevent Render free spin-down)
  const pingTimer = setInterval(() => {
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.ping();
    } catch {}
    try {
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.ping();
    } catch {}
  }, 20000);

  const clear = () => clearInterval(pingTimer);
  clientWs.on("close", clear);
  openaiWs.on("close", clear);
});

server.listen(PORT, "0.0.0.0", () => {
  log("Listening on :" + PORT);
  log("WS endpoint: ws://localhost:" + PORT + "/realtime");
  log("Upstream OPENAI_REALTIME_URL:", OPENAI_REALTIME_URL);
});
