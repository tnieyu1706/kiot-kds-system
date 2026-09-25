// content.js - chay tren https://fnb.kiotviet.vn/
// Nhiem vu: bat click nut Thanh toan (.btn-payment-order) va POST ve server NodeJS.

const DEFAULT_SERVER = "http://localhost:3000";
let SERVER_URL = DEFAULT_SERVER;

// Load server URL tu storage (cho phep doi trong popup)
try {
  chrome.storage.local.get(["serverUrl"], (res) => {
    if (res && res.serverUrl) SERVER_URL = res.serverUrl.replace(/\/$/, "");
    console.log("[KV-Hook] server:", SERVER_URL);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.serverUrl) {
      SERVER_URL = changes.serverUrl.newValue.replace(/\/$/, "");
      console.log("[KV-Hook] doi server:", SERVER_URL);
    }
  });
} catch (e) {
  console.warn("[KV-Hook] khong doc duoc storage, dung default", e);
}

function isPaymentButton(el) {
  if (!el || !el.closest) return false;
  // Chinh xac: button.btn-payment-order NAM TRONG div.print-language-split--payment
  // <div class="print-language-split print-language-split--payment">
  //   <button class="btn btn-payment-order btn-primary">Thanh toán</button>
  // </div>
  const btn = el.closest("button.btn-payment-order");
  if (!btn) return false;
  const parent = btn.closest("div.print-language-split--payment");
  if (!parent) return false;
  const txt = (btn.innerText || "").toLowerCase();
  if (!txt.includes("thanh toán")) return false;
  return btn;
}

function textOf(el) {
  return ((el && (el.innerText || el.textContent)) || "").trim();
}

// Chẩn đoán khi bóc rỗng: chạy window.KVDebug() trong Console trang cashier
function debugOrderSelectors() {
  const info = {};
  try {
    const cw = document.querySelectorAll(".customer-name");
    info.customerWraps = cw.length;
    info.customerSamples = Array.from(cw).slice(0, 2).map((e) => e.outerHTML.slice(0, 300));
    const al = document.querySelectorAll(".customer-name a");
    info.customerLinks = al.length;
    info.customerLinkTexts = Array.from(al).slice(0, 3).map((e) => textOf(e));
    const list = document.querySelectorAll(".product-cart-list");
    info.cartLists = list.length;
    const items = document.querySelectorAll(".product-cart-item");
    info.cartItems = items.length;
    if (items.length) {
      const r = items[0];
      info.firstItemHtml = r.outerHTML.slice(0, 500);
      info.firstName = textOf(r.querySelector(".product-name-text"));
      info.firstQty = textOf(r.querySelector(".item-quantity"));
    }
    info.anyCustomerLike = document.querySelectorAll('[class*="customer"]').length;
    info.anyCartLike = document.querySelectorAll('[class*="product-cart"]').length;
    info.url = location.href;
  } catch (e) {
    info.error = String(e);
  }
  return info;
}
window.KVDebug = () => {
  const d = debugOrderSelectors();
  console.log("[KV-Hook] DEBUG selectors:", d);
  console.log("[KV-Hook] DEBUG order:", getOrderData());
  return d;
};
function cleanProductName(raw) {
  // "1. gà nướng" -> "gà nướng" (bo so thu tu + dau cham o dau)
  return (raw || "").trim().replace(/^\d+\s*\.\s*/, "").trim();
}

function cleanTopping(raw) {
  // " + 1 vị ớt nướng " -> "1 vị ớt nướng" (trim + bo dau + o dau)
  return (raw || "").trim().replace(/^\+\s*/, "").trim();
}

function getOrderData() {
  // Spec KDS (mục 2+5): { orderCode, items: [{name, quantity}] }
  // - orderCode: .customer-name > a (vd "9128")
  // - items: .product-cart-list > .product-cart-item, tên đã gộp topping
  let orderCode = "";
  try {
    const wrap = document.querySelector(".customer-name");
    const a = wrap ? wrap.querySelector("a") : null;
    orderCode = textOf(a);
    if (!orderCode) orderCode = textOf(wrap); // fallback: lấy text cả khối
  } catch {}

  // 2) Danh sach mon: .product-cart-list > .product-cart-item
  const items = [];
  try {
    const list = document.querySelector(".product-cart-list");
    const rows = list
      ? list.querySelectorAll(".product-cart-item")
      : document.querySelectorAll(".product-cart-item"); // fallback: quét toàn trang
    rows.forEach((r) => {
      const nameEl = r.querySelector(".product-name-text");
      const qtyEl = r.querySelector(".item-quantity");
      const rawName = textOf(nameEl);
      const baseName = cleanProductName(rawName);

      // Topping: .list-topping > span (1 hoac nhieu), noi bang dau phay
      let toppingStr = "";
      try {
        const topWrap = r.querySelector(".list-topping");
        const spans = topWrap ? topWrap.querySelectorAll("span") : [];
        const parts = [];
        spans.forEach((s) => {
          const t = cleanTopping(textOf(s));
          if (t) parts.push(t);
        });
        if (parts.length) toppingStr = parts.join(", ");
      } catch {}

      // Gop: <ten mon> (<topping>), khong topping thi giu nguyen
      const name = toppingStr ? `${baseName} (${toppingStr})` : baseName;

      // Số lượng: text .item-quantity, fallback input bên trong item
      let qtyText = textOf(qtyEl);
      if (!qtyText) {
        const input = r.querySelector("input");
        qtyText = (input && input.value ? String(input.value) : "").trim();
      }
      const qty = parseInt((qtyText || "").replace(/[^\d-]/g, ""), 10);
      if (!name) return;
      if (!Number.isInteger(qty) || qty <= 0) return; // server validate quantity > 0
      items.push({ name, quantity: qty });
    });
  } catch {}

  // KiotViet tách item-cart thành nhiều dòng trùng tên -> gộp lại, cộng dồn SL
  const merged = [];
  const byName = new Map();
  items.forEach((it) => {
    if (byName.has(it.name)) {
      byName.get(it.name).quantity += it.quantity;
    } else {
      const e = { name: it.name, quantity: it.quantity };
      byName.set(it.name, e);
      merged.push(e);
    }
  });

  return { orderCode, items: merged };
}

async function notifyServer(buttonEl) {
  const order = getOrderData();
  console.log("[KV-Hook] bam Thanh toan, order boc duoc:", order);

  // Validate nhẹ phía extension theo spec (server cũng validate lại + trả 400)
  if (!order.orderCode || !order.items.length) {
    console.warn("[KV-Hook] bỏ qua: thiếu orderCode hoặc items rỗng", debugOrderSelectors());
    showToast("⚠️ Không bóc được đơn (xem Console)");
    return;
  }

  // Gui qua background.js de bypass PNA (public https -> localhost bi chan).
  // Luồng 1 chiều: chỉ gửi POST /api/orders, không cần gì ngược lại.
  try {
    const res = await chrome.runtime.sendMessage({
      type: "KV_ORDER_NEW",
      serverUrl: SERVER_URL,
      order
    });
    if (res?.ok) {
      console.log("[KV-Hook] server tra ve:", res.data);
      showToast("Đã gửi về server ✅");
    } else {
      console.error("[KV-Hook] loi gui ve server:", res?.error);
      showToast("Lỗi gửi server ❌ (xem Console)");
    }
  } catch (err) {
    console.error("[KV-Hook] loi gui ve server:", err);
    showToast("Lỗi gửi server ❌ (xem Console)");
  }
}

// Toast nho de biet da hook duoc (tien test)
function showToast(msg) {
  try {
    const div = document.createElement("div");
    div.textContent = msg;
    div.style.cssText =
      "position:fixed;bottom:20px;right:20px;background:#222;color:#fff;" +
      "padding:10px 14px;border-radius:8px;z-index:999999;font-size:14px;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.3);opacity:.95;";
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 2500);
  } catch {}
}

// Bat click o capture-phase de khong miss (Angular SPA render lai van bat duoc)
// KHONG preventDefault / stopPropagation -> giu hanh vi goc cua KiotViet
document.addEventListener(
  "click",
  (e) => {
    const btn = isPaymentButton(e.target);
    if (btn) {
      notifyServer(btn);
    }
  },
  true
);

// Observer chi de debug: bao khi nut xuat hien (Angular render tre)
const observer = new MutationObserver(() => {
  const btn = document.querySelector(
    "div.print-language-split--payment button.btn-payment-order"
  );
  if (btn && !btn.dataset.kvHooked) {
    btn.dataset.kvHooked = "1";
    console.log("[KV-Hook] da thay nut Thanh toan:", btn.innerText?.trim());
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });

console.log("[KV-Hook] loaded tren", location.href);
