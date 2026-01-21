import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = parseInt(process.env.PORT || "10000", 10);

// Render 上用環境變數設定（不要把 key 寫死在 repo）
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL =
  process.env.OPENAI_REALTIME_URL ||
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.error("Missing env OPENAI_API_KEY");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // 健康檢查：Render / 或你自己用來喚醒 free service
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

// WebSocket Server（noServer 模式，接管 upgrade）
const wss = new WebSocketServer({ noServer: true });

function safeClose(ws, code, reason) {
  try { ws.close(code, reason); } catch {}
}

server.on("upgrade", (req, socket, head) => {
  // 只允許 /realtime 這個 WS path
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
  console.log("Client WS connected:", req.url);

  // 連到 OpenAI 官方 Realtime（這裡補 Bearer）
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
      // OpenAI 是否需要額外 beta header 以官方文件為準；
      // 若你測到需要，可加： "OpenAI-Beta": "realtime=v1"
    }
  });

  const closeBoth = (code = 1000, reason = "closing") => {
    safeClose(clientWs, code, reason);
    safeClose(openaiWs, code, reason);
  };

  // 雙向轉發（binary/text 原封不動）
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

  openaiWs.on("open", () => console.log("Connected to OpenAI Realtime"));
  openaiWs.on("close", (code, reason) => {
    console.log("OpenAI WS closed:", code, reason?.toString());
    closeBoth(1000, "openai closed");
  });
  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err?.message || err);
    closeBoth(1011, "openai error");
  });

  clientWs.on("close", (code, reason) => {
    console.log("Client WS closed:", code, reason?.toString());
    closeBoth(1000, "client closed");
  });
  clientWs.on("error", (err) => {
    console.error("Client WS error:", err?.message || err);
    closeBoth(1011, "client error");
  });

  // 可選：每 20 秒 ping，避免某些中間層 idle timeout（不保證能防 Render free spin down）
  const pingTimer = setInterval(() => {
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.ping();
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.ping();
    } catch {}
  }, 20000);

  clientWs.on("close", () => clearInterval(pingTimer));
  openaiWs.on("close", () => clearInterval(pingTimer));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on :${PORT}`);
  console.log(`WS endpoint: ws://localhost:${PORT}/realtime`);
});
