import { defineUnlistedScript } from "#imports";

export default defineUnlistedScript(() => {
  "use strict";

  const SOURCE = "colonist-stats-helper";

  if (window.__colonistStatsHelperWsHookInstalled) {
    return;
  }

  window.__colonistStatsHelperWsHookInstalled = true;

  const OriginalWebSocket = window.WebSocket;

  if (!OriginalWebSocket) {
    return;
  }

  const textDecoder = new TextDecoder("utf-8", { fatal: false });

  function post(type, payload) {
    window.postMessage({ source: SOURCE, type, payload }, "*");
  }

  function printableRatio(text) {
    if (!text) {
      return 0;
    }

    let printable = 0;
    const sample = text.slice(0, 1000);

    for (let index = 0; index < sample.length; index += 1) {
      const code = sample.charCodeAt(index);

      if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || code >= 160) {
        printable += 1;
      }
    }

    return printable / sample.length;
  }

  function hexPreview(bytes) {
    return Array.from(bytes.slice(0, 32))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ");
  }

  function decodeBuffer(buffer, mimeType) {
    const bytes = new Uint8Array(buffer);
    const text = textDecoder.decode(bytes);

    if (printableRatio(text) >= 0.75) {
      return {
        kind: "text",
        text,
        size: bytes.byteLength,
        mimeType: mimeType || "",
        encoding: "utf-8"
      };
    }

    return {
      kind: "binary",
      size: bytes.byteLength,
      mimeType: mimeType || "",
      preview: hexPreview(bytes)
    };
  }

  async function normalizeData(data) {
    if (typeof data === "string") {
      return {
        kind: "text",
        text: data,
        size: data.length,
        encoding: "string"
      };
    }

    if (data instanceof ArrayBuffer) {
      return decodeBuffer(data, "");
    }

    if (ArrayBuffer.isView(data)) {
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return decodeBuffer(buffer, "");
    }

    if (typeof Blob !== "undefined" && data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      return decodeBuffer(buffer, data.type);
    }

    return {
      kind: typeof data,
      size: 0,
      preview: String(data).slice(0, 200)
    };
  }

  function captureFrame(direction, url, data) {
    const createdAt = Date.now();

    normalizeData(data)
      .then((normalizedData) => {
        post("ws-frame", {
          direction,
          url: String(url || ""),
          createdAt,
          timestamp: new Date(createdAt).toISOString(),
          data: normalizedData
        });
      })
      .catch((error) => {
        post("ws-frame-error", {
          direction,
          url: String(url || ""),
          createdAt,
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }

  function attachWebSocketCapture(socket, url) {
    socket.addEventListener("message", (event) => {
      captureFrame("incoming", url, event.data);
    });

    const originalSend = socket.send;

    socket.send = function sendWithCapture(data) {
      captureFrame("outgoing", url, data);
      return originalSend.call(this, data);
    };
  }

  const WrappedWebSocket = new Proxy(OriginalWebSocket, {
    construct(target, args) {
      const socket = args.length > 1 ? new target(args[0], args[1]) : new target(args[0]);

      attachWebSocketCapture(socket, args[0]);

      post("ws-opened", {
        url: String(args[0] || ""),
        createdAt: Date.now()
      });

      return socket;
    }
  });

  window.WebSocket = WrappedWebSocket;

  post("ws-hook-ready", {
    createdAt: Date.now()
  });
});
