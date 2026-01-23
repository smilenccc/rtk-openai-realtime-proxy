/**
 * rtk-openai-realtime-proxy - server.js
 *
 * Endpoints:
 *   HTTP  GET  /health              -> "ok" (plain text, for existing usage)
 *   HTTP  POST /gemini/chat         -> { ok:true, text:"..." }
 *   HTTP  POST /gemini/translate    -> { ok:true, text:"..." }
 *   WS    WSS  /realtime            -> proxy to OpenAI Realtime WS
 *
 * Required env:
 *   OPENAI_API_KEY        = "sk-..." (for /realtime only)
 *
 * Optional env:
 *   OPENAI_REALTIME_URL   = "wss://api.openai.com/v1/realtime?model=gpt-realtime"
 *   GEMINI_API_KEY        = "..." (for /gemini/* only)
 *   GEMINI_API_VERSION    = "v1beta" (default)
 *   PORT                  = (Render provides)
 */

import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = parseInt(process.env.PORT || "10000", 10);

// ===== OpenAI Realtime (WS proxy) =====
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_REALTIME_URL =
  (process.env.OPENAI_REALTIME_URL || "").trim() ||
  "wss://api.openai.com/v1/realtime?model=gpt-realtime";

// ===== Gemini (HTTP proxy) =====
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_API_VERSION = (process.env.GEMINI_API_VERSION || "v1beta").trim();
const GEMINI_API_BASE = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}`;

// OpenAI key only required for WS /realtime.
// We allow server to start even if missing, but WS will fail if used.
if (!OPENAI_API_KEY) {
  console.warn("[WARN] Missing env OPENAI_API_KEY (WS /realtime will not work)");
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

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  // Minimal JSON parser for plain http server
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", (e) => reject(e));
  });
}

function extractGeminiText(json) {
  try {
    const cands = json?.candidates;
    if (!Array.isArray(cands) || cands.length === 0) return "";
    const parts = cands[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) return "";
    return parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("").trim();
  } catch {
    return "";
  }
}

async function geminiGenerateContent({ model, text, system, generationConfig }) {
  if (!GEMINI_API_KEY) {
    const e = new Error("Missing env GEMINI_API_KEY");
    e.statusCode = 500;
    throw e;
  }
  if (!model || typeof model !== "string") {
    const e = new Error("Missing model");
    e.statusCode = 400;
    throw e;
  }
  if (!text || typeof text !== "string") {
    const e = new Error("Missing text");
    e.statusCode = 400;
    throw e;
  }

  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text }],
      },
    ],
  };

  // System instruction (optional)
  if (system && typeof system === "string" && system.trim()) {
    payload.systemInstruction = {
      parts: [{ text: system.trim() }],
    };
  }

  // generationConfig (optional)
  if (generationConfig && typeof generationConfig === "object") {
    payload.generationConfig = generationConfig;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // IMPORTANT: put key in header to avoid logging/leaking via URL
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const raw = await resp.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }

  if (!resp.ok) {
    const e = new Error(`Gemini HTTP ${resp.status}`);
    e.statusCode = 502;
    e.upstreamStatus = resp.status;
    e.upstreamBody = raw?.slice(0, 2000) || "";
    throw e;
  }

  const outText = extractGeminiText(json);
  return {
    text: outText || "",
    rawJson: json,
  };
}

// =====================
// HTTP Server
// =====================
const server = http.createServer(async (req, res) => {
  const method = (req.method || "GET").toUpperCase();
  const url = req.url || "/";

  // Existing health endpoint
  if (method === "GET" && (url === "/" || url === "/health")) {
    // keep plain text "ok" for your existing Android test
    sendText(res, 200, "ok");
    return;
  }

  // Gemini: chat
  if (method === "POST" && url === "/gemini/chat") {
    try {
      const body = await readJsonBody(req);

      const model = body.model || "gemini-2.5-flash-lite";
      const text = body.text || "";
      const system = body.system || "";
      const generationConfig = body.generationConfig || { maxOutputTokens: 256 };

      log("[Gemini] /gemini/chat model=", model, "textLen=", String(text).length);

      const r = await geminiGenerateContent({
        model,
        text,
        system,
        generationConfig,
      });

      sendJson(res, 200, {
        ok: true,
        text: r.text,
      });
    } catch (e) {
      err("[Gemini] /gemini/chat error:", e?.message || e);
      sendJson(res, e.statusCode || 500, {
        ok: false,
        error: e?.message || "error",
        upstreamStatus: e.upstreamStatus,
        upstreamBody: e.upstreamBody,
      });
    }
    return;
  }

  // Gemini: translate
  if (method === "POST" && url === "/gemini/translate") {
    try {
      const body = await readJsonBody(req);

      const model = body.model || "gemini-2.5-flash-lite";
      const text = body.text || "";
      const targetLang = body.targetLang || "zh-TW";

      const prompt = `請把以下文字翻譯成 ${targetLang}，只輸出翻譯結果，不要任何多餘說明：\n\n${text}`;

      log("[Gemini] /gemini/translate model=", model, "target=", targetLang, "textLen=", String(text).length);

      const r = await geminiGenerateContent({
        model,
        text: prompt,
        system: "",
        generationConfig: { maxOutputTokens: 256 },
      });

      sendJson(res, 200, {
        ok: true,
        text: r.text,
      });
    } catch (e) {
      err("[Gemini] /gemini/translate error:", e?.message || e);
      sendJson(res, e.statusCode || 500, {
        ok: false,
        error: e?.message || "error",
        upstreamStatus: e.upstreamStatus,
        upstreamBody: e.upstreamBody,
      });
    }
    return;
  }

  // Not found
  sendText(res, 404, "not found");
});

// =====================
// WS Server (OpenAI Realtime proxy)
// =====================

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

  if (!OPENAI_API_KEY) {
    err("[OpenAI] Missing OPENAI_API_KEY; closing client");
    safeClose(clientWs, 1011, "missing OPENAI_API_KEY");
    return;
  }

  // Connect upstream to OpenAI Realtime WS
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWs.on("unexpected-response", (_req, res) => {
    err("[OpenAI] unexpected-response:", res.statusCode, res.statusMessage || "");
    safeClose(clientWs, 1011, `openai unexpected-response ${res.statusCode}`);
    safeTerminate(openaiWs);
  });

  const closeBoth = (code = 1000, reason = "closing") => {
    safeClose(clientWs, code, reason);
    safeClose(openaiWs, code, reason);
    setTimeout(() => {
      safeTerminate(clientWs);
      safeTerminate(openaiWs);
    }, 1500);
  };

  openaiWs.on("open", () => {
    log("[OpenAI] Connected to OpenAI Realtime");
  });

  openaiWs.on("message", (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on("message", (data, isBinary) => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(data, { binary: isBinary });
    }
  });

  openaiWs.on("close", (code, reason) => {
    log("[OpenAI] WS closed:", code, reason?.toString() || "");
    closeBoth(1000, "openai closed");
  });

  openaiWs.on("error", (e) => {
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
  log("Gemini HTTP enabled:", GEMINI_API_KEY ? "YES" : "NO (missing GEMINI_API_KEY)");
  log("Gemini base:", GEMINI_API_BASE);
});
