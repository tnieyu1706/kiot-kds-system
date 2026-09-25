// background.js - service worker: fetch ve localhost o day de bypass PNA/CORS.
// Content script chay trong origin https://fnb.kiotviet.vn -> bi Chrome chan
// khi goi http://localhost (loopback). Background co host_permissions
// nen goi thang localhost khong bi chan.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Luồng chính (spec KDS): content bóc {orderCode, items} -> POST /api/orders
  if (msg?.type === "KV_ORDER_NEW") {
    const serverUrl = (msg.serverUrl || "http://localhost:3000").replace(/\/$/, "");
    fetch(`${serverUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.order)
    })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (r.ok) sendResponse({ ok: true, data });
        else sendResponse({ ok: false, error: data?.error || `HTTP ${r.status}` });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // giu channel async
  }

  if (msg?.type === "KV_PAYMENT_CLICK") {
    const serverUrl = (msg.serverUrl || "http://localhost:3000").replace(/\/$/, "");
    fetch(`${serverUrl}/api/payment-click`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.payload)
    })
      .then((r) => r.json().catch(() => ({})))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // giu channel async
  }

  if (msg?.type === "KV_HEALTH_CHECK") {
    const serverUrl = (msg.serverUrl || "http://localhost:3000").replace(/\/$/, "");
    fetch(`${serverUrl}/health`)
      .then((r) => r.json().catch(() => ({})))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});
