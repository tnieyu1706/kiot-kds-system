// KDS Server - Node.js + Express + Socket.IO, lưu RAM (mất khi restart).
// Spec: kds-system-plan-v2.md mục 3.
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PATCH", "DELETE"] }
});

const PORT = process.env.PORT || 3000;

app.use(express.json());

// Fix Chrome Private Network Access (public https -> localhost loopback)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.header("Access-Control-Allow-Origin", origin || "*");
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Store RAM ---
const orders = [];
let nextSequence = 1;

function validateOrderPayload(body) {
  if (!body || typeof body !== "object") return { valid: false, error: "Body phải là JSON object" };
  const orderCode = typeof body.orderCode === "string" ? body.orderCode.trim() : "";
  if (!orderCode) return { valid: false, error: "Thiếu orderCode (string không rỗng)" };
  if (!Array.isArray(body.items) || body.items.length === 0)
    return { valid: false, error: "items phải là mảng không rỗng" };
  const items = [];
  for (let i = 0; i < body.items.length; i++) {
    const it = body.items[i] || {};
    const name = typeof it.name === "string" ? it.name.trim() : "";
    const qty = Number(it.quantity);
    if (!name) return { valid: false, error: `items[${i}].name không hợp lệ` };
    if (!Number.isInteger(qty) || qty <= 0)
      return { valid: false, error: `items[${i}].quantity phải là số nguyên > 0` };
    items.push({ name, quantity: qty });
  }
  return { valid: true, orderCode, items };
}

function createOrder(orderCode, items) {
  const totalQuantity = items.reduce((s, it) => s + it.quantity, 0);
  const order = {
    id: crypto.randomUUID(),
    sequenceNumber: nextSequence++,
    orderCode,
    receivedAt: new Date().toISOString(),
    completedAt: null,
    totalQuantity,
    items,
    status: "pending"
  };
  orders.push(order);
  return order;
}

// --- API ---
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), orders: orders.length });
});

// B2: POST đơn mới từ extension
app.post("/api/orders", (req, res) => {
  const v = validateOrderPayload(req.body);
  if (!v.valid) return res.status(400).json({ ok: false, error: v.error });

  const order = createOrder(v.orderCode, v.items);
  console.log(`🔔 Đơn mới #${order.sequenceNumber} (${order.orderCode}):`, JSON.stringify(order.items));
  io.emit("order:new", order);
  return res.status(201).json(order);
});

// B2: Client load danh sách ban đầu
app.get("/api/orders", (req, res) => {
  res.json(orders);
});

// B4: Bếp bấm hoàn thành
app.patch("/api/orders/:id/complete", (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: "Không tìm thấy đơn" });
  order.status = "completed";
  order.completedAt = new Date().toISOString();
  console.log(`✅ Hoàn thành #${order.sequenceNumber} (${order.orderCode})`);
  io.emit("order:completed", { id: order.id });
  return res.json(order);
});

// Bếp/server bấm nhầm hoàn thành -> hoàn tác về đang chờ
app.patch("/api/orders/:id/reopen", (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: "Không tìm thấy đơn" });
  order.status = "pending";
  order.completedAt = null;
  console.log(`↩️ Hoàn tác #${order.sequenceNumber} (${order.orderCode}) về đang chờ`);
  io.emit("order:reopened", { id: order.id });
  return res.json(order);
});

// --- Alias cũ cho extension hiện tại (gửi /api/payment-click + data string) ---
// Giữ lại để test end-to-end trước khi sửa extension sang /api/orders ở B7.
app.post("/api/payment-click", (req, res) => {
  try {
    let orderCode = "";
    let items = [];
    if (req.body && typeof req.body.data === "string") {
      const parsed = JSON.parse(req.body.data);
      orderCode = (parsed.customerCode || "").toString().trim();
      items = Array.isArray(parsed.items) ? parsed.items : [];
    } else if (req.body && req.body.orderCode) {
      orderCode = (req.body.orderCode || "").toString().trim();
      items = req.body.items || [];
    }
    const v = validateOrderPayload({ orderCode, items });
    if (!v.valid) {
      console.log("⚠️ /api/payment-click payload chưa chuẩn KDS:", v.error);
      return res.json({ ok: true, received: true, kds: false, error: v.error });
    }
    const order = createOrder(v.orderCode, v.items);
    console.log(`🔔 (legacy) Đơn mới #${order.sequenceNumber} (${order.orderCode})`);
    io.emit("order:new", order);
    return res.json({ ok: true, received: true, kds: true, order });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/logs", (req, res) => {
  res.json({ count: orders.length, logs: orders });
});

// Thống kê cho trang quản lý
app.get("/api/stats", (req, res) => {
  const pending = orders.filter((o) => o.status !== "completed").length;
  res.json({
    total: orders.length,
    pending,
    completed: orders.length - pending,
    sockets: io.engine.clientsCount
  });
});

// Xóa 1 đơn
app.delete("/api/orders/:id", (req, res) => {
  const i = orders.findIndex((o) => o.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, error: "Không tìm thấy đơn" });
  const [del] = orders.splice(i, 1);
  console.log(`🗑️ Xóa đơn #${del.sequenceNumber} (${del.orderCode})`);
  io.emit("order:deleted", { id: del.id });
  return res.json({ ok: true, deleted: { id: del.id } });
});

// Xóa hàng loạt: ?status=completed (xóa đã xong) hoặc ?all=1 (xóa tất cả)
app.delete("/api/orders", (req, res) => {
  let targets;
  if (req.query.all === "1") targets = orders.slice();
  else if (req.query.status === "completed") targets = orders.filter((o) => o.status === "completed");
  else return res.status(400).json({ ok: false, error: "Thiếu ?status=completed hoặc ?all=1" });
  const ids = targets.map((o) => o.id);
  ids.forEach((id) => {
    const i = orders.findIndex((o) => o.id === id);
    if (i >= 0) orders.splice(i, 1);
  });
  ids.forEach((id) => io.emit("order:deleted", { id }));
  console.log(`🗑️ Xóa hàng loạt ${ids.length} đơn`);
  return res.json({ ok: true, deletedIds: ids });
});

// Trang quản lý: xem + tìm kiếm/lọc + hoàn thành + xóa, realtime
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);
  socket.on("disconnect", () => console.log("🔌 Client disconnected:", socket.id));
});

server.listen(PORT, () => {
  console.log(`✅ KDS Server chạy tại http://localhost:${PORT}`);
  console.log(`👉 Xem đơn: http://localhost:${PORT}`);
});
