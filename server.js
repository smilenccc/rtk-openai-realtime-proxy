/**
 * rtk-openai-realtime-proxy - server.js (completed)
 *
 * Endpoints:
 *   HTTP  GET  /health              -> "ok" (plain text)
 *   HTTP  POST /gemini/chat         -> { ok:true, text:"..." }
 *   HTTP  POST /gemini/translate    -> { ok:true, text:"..." }
 *   HTTP  POST /gemini/semantics    -> { ok:true, intent, slots, confidence, brief, raw }
 *   HTTP  POST /openai/chat         -> { ok:true, text:"..." }
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

// ===== Helpers =====
function now() { return new Date().toISOString(); }
function log(...args) { console.log(now(), ...args); }
function err(...args) { console.error(now(), ...args); }

function safeKeySuffix(k) {
  if (!k) return "(missing)";
  return "****" + k.slice(-4);
}

function setCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,x-request-id");
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  setCors(res);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  setCors(res);
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
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
        err("[HTTP] invalid json raw(head)=", raw.slice(0, 200));
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

function extractFirstJsonObject(input) {
  const s = String(input || "").trim();
  if (!s) return null;

  let started = false, depth = 0, inString = false, escape = false, startIdx = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!started) {
      if (c === "{") { started = true; startIdx = i; depth = 1; }
      continue;
    }
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === "\"") inString = false;
      continue;
    } else {
      if (c === "\"") inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0 && startIdx >= 0) return s.substring(startIdx, i + 1);
      }
    }
  }
  return null;
}

async function geminiGenerateContent({ model, text, system, generationConfig }) {
  if (!globalThis.fetch) {
    const e = new Error("Node fetch not available. Please use Node 18+.");
    e.statusCode = 500;
    throw e;
  }
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
      { role: "user", parts: [{ text }] },
    ],
  };

  if (system && typeof system === "string" && system.trim()) {
    payload.systemInstruction = { parts: [{ text: system.trim() }] };
  }
  if (generationConfig && typeof generationConfig === "object") {
    payload.generationConfig = generationConfig;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Key in header (avoid leaking in URL)
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const raw = await resp.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* ignore */ }

  if (!resp.ok) {
    const e = new Error(`Gemini HTTP ${resp.status}`);
    e.statusCode = 502;
    e.upstreamStatus = resp.status;
    e.upstreamBody = raw?.slice(0, 2000) || "";
    throw e;
  }

  return { text: extractGeminiText(json), rawJson: json };
}

// =====================
// HTTP Server
// =====================
const server = http.createServer(async (req, res) => {
  const method = (req.method || "GET").toUpperCase();
  const url = req.url || "/";

  // CORS preflight
  if (method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Health
  if (method === "GET" && (url === "/" || url === "/health")) {
    sendText(res, 200, "ok");
    return;
  }

  // Gemini: chat (raw proxy)
  if (method === "POST" && url === "/gemini/chat") {
    try {
      const body = await readJsonBody(req);

      const model = body.model || "gemini-2.5-flash-lite";
      const text = body.text || "";
      const system = body.system || "";
      const generationConfig = body.generationConfig || { maxOutputTokens: 256 };

      log(`[Gemini] /gemini/chat model=${model} textLen=${String(text).length} key=${safeKeySuffix(GEMINI_API_KEY)}`);

      const r = await geminiGenerateContent({ model, text, system, generationConfig });

      sendJson(res, 200, { ok: true, text: r.text });
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

      log(`[Gemini] /gemini/translate model=${model} target=${targetLang} textLen=${String(text).length} key=${safeKeySuffix(GEMINI_API_KEY)}`);

      const r = await geminiGenerateContent({
        model,
        text: prompt,
        system: "",
        generationConfig: { maxOutputTokens: 256 },
      });

      sendJson(res, 200, { ok: true, text: r.text });
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

  // Gemini: semantics (recommended for stability)
  // body: { model?, text, maxOutputTokens? }
  // resp: { ok:true, intent, slots, confidence, brief, raw }
  if (method === "POST" && url === "/gemini/semantics") {
    try {
      const body = await readJsonBody(req);

      const model = body.model || "gemini-2.5-flash-lite";
      const userText = String(body.text || "").trim();
      const maxOutputTokens = Number(body.maxOutputTokens || 256);

      if (!userText) {
        sendJson(res, 400, { ok: false, error: "Missing text" });
        return;
      }

      const system = `
你是一個嚴格的 JSON 產生器。
請只輸出一個「可被 JSON.parse 直接解析」的 JSON 物件，不要有任何多餘文字、不要 markdown。
JSON 欄位規格：
- intent: string (小寫)
- slots: object
- confidence: number 0~1
- brief: string (<=20字，繁中)
`.trim();

      const prompt = `
使用者語句如下：
${userText}

請推斷 intent（例如：music_play, music_stop, open_navigation, calendar_query, calendar_add）。
slots 範例：
- open_navigation: {"destination":"台中車站"}
- calendar_add: {"title":"...","date":"YYYY-MM-DD","time":"HH:mm"}
`.trim();

      log(`[Gemini] /gemini/semantics model=${model} textLen=${userText.length} key=${safeKeySuffix(GEMINI_API_KEY)}`);

      const r = await geminiGenerateContent({
        model,
        text: prompt,
        system,
        generationConfig: { maxOutputTokens },
      });

      const rawText = r.text || "";
      const jsonText = extractFirstJsonObject(rawText) || rawText.trim();
      let parsed = null;
      try { parsed = JSON.parse(jsonText); } catch { /* ignore */ }

      if (!parsed || typeof parsed !== "object") {
        sendJson(res, 200, { ok: true, intent: "unknown", slots: {}, confidence: 0, brief: "parse_error", raw: rawText });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        intent: String(parsed.intent || "unknown").trim().toLowerCase(),
        slots: parsed.slots && typeof parsed.slots === "object" ? parsed.slots : {},
        confidence: Number(parsed.confidence || 0),
        brief: String(parsed.brief || ""),
        raw: rawText,
      });
    } catch (e) {
      err("[Gemini] /gemini/semantics error:", e?.message || e);
      sendJson(res, e.statusCode || 500, {
        ok: false,
        error: e?.message || "error",
        upstreamStatus: e.upstreamStatus,
        upstreamBody: e.upstreamBody,
      });
    }
    return;
  }

  // OpenAI: chat (same interface as /gemini/chat)
  // body: { model?, text, system? }
  // resp: { ok:true, text:"..." }
  if (method === "POST" && url === "/openai/chat") {
    try {
      if (!OPENAI_API_KEY) {
        const e = new Error("Missing env OPENAI_API_KEY");
        e.statusCode = 500;
        throw e;
      }

      const body = await readJsonBody(req);

      const model = body.model || "gpt-4o-mini";
      const text = String(body.text || "").trim();
      const system = String(body.system || "").trim();

      if (!text) {
        sendJson(res, 400, { ok: false, error: "Missing text" });
        return;
      }

      log(`[OpenAI] /openai/chat model=${model} textLen=${text.length} key=${safeKeySuffix(OPENAI_API_KEY)}`);

      const messages = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: text });

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 1024,
        }),
      });

      const raw = await resp.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* ignore */ }

      if (!resp.ok) {
        const errMsg = json?.error?.message || raw?.slice(0, 500) || `HTTP ${resp.status}`;
        const e = new Error(`OpenAI HTTP ${resp.status}: ${errMsg}`);
        e.statusCode = 502;
        e.upstreamStatus = resp.status;
        e.upstreamBody = raw?.slice(0, 2000) || "";
        throw e;
      }

      const content = json?.choices?.[0]?.message?.content?.trim() || "";
      sendJson(res, 200, { ok: true, text: content });
    } catch (e) {
      err("[OpenAI] /openai/chat error:", e?.message || e);
      sendJson(res, e.statusCode || 500, {
        ok: false,
        error: e?.message || "error",
        upstreamStatus: e.upstreamStatus,
        upstreamBody: e.upstreamBody,
      });
    }
    return;
  }

  sendText(res, 404, "not found");
});

// =====================
// WS Server (OpenAI Realtime proxy)
// =====================
const wss = new WebSocketServer({ noServer: true });

function safeClose(ws, code, reason) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(code, reason); } catch {}
}
function safeTerminate(ws) { try { ws.terminate(); } catch {} }

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

  openaiWs.on("open", () => log("[OpenAI] Connected to OpenAI Realtime"));
  openaiWs.on("message", (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
  });
  clientWs.on("message", (data, isBinary) => {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(data, { binary: isBinary });
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

  const pingTimer = setInterval(() => {
    try { if (clientWs.readyState === WebSocket.OPEN) clientWs.ping(); } catch {}
    try { if (openaiWs.readyState === WebSocket.OPEN) openaiWs.ping(); } catch {}
  }, 20000);

  const clear = () => clearInterval(pingTimer);
  clientWs.on("close", clear);
  openaiWs.on("close", clear);
});

server.listen(PORT, "0.0.0.0", () => {
  log("Listening on :" + PORT);
  log("WS endpoint: ws://localhost:" + PORT + "/realtime");
  log("Upstream OPENAI_REALTIME_URL:", OPENAI_REALTIME_URL);
  log("Gemini HTTP enabled:", GEMINI_API_KEY ? "YES key=" + safeKeySuffix(GEMINI_API_KEY) : "NO (missing GEMINI_API_KEY)");
  log("Gemini base:", GEMINI_API_BASE);
});
