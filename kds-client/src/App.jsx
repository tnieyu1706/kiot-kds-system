import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { QRCodeSVG } from "qrcode.react";

const SERVER_URL = import.meta.env.VITE_KDS_URL || "http://localhost:3000";

// URL của chính client này cho thiết bị khác cùng mạng quét vào:
// lấy host từ VITE_KDS_URL (IP LAN) + port của trang đang mở (5173/4173...).
function getClientLanUrl() {
  try {
    const srv = new URL(SERVER_URL);
    const proto = window.location.protocol || "http:";
    const port = window.location.port ? ":" + window.location.port : "";
    return proto + "//" + srv.hostname + port + "/";
  } catch {
    return window.location.origin + "/";
  }
}

function padSeq(n) {
  return String(n);
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  } catch {
    return "";
  }
}

export default function App() {
  const [orders, setOrders] = useState([]);
  const [connected, setConnected] = useState(false);
  // Settings: danh sách key lọc món (dễ thêm/xóa/sửa từng key).
  // Rỗng = hiện tất cả. Lưu localStorage để giữ sau reload.
  // Data gốc từ server giữ nguyên — filter chỉ áp dụng lúc render.
  const [filterList, setFilterList] = useState(() => {
    try {
      const raw = localStorage.getItem("kds-filter-list");
      if (raw) {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
      }
      // Migrate từ bản cũ (chuỗi cách nhau dấu phẩy)
      const legacy = localStorage.getItem("kds-filter-keys") || "";
      return legacy.split(",").map((k) => k.trim()).filter(Boolean);
    } catch {
      return [];
    }
  });
  const [draft, setDraft] = useState("");

  function persist(list) {
    setFilterList(list);
    try {
      localStorage.setItem("kds-filter-list", JSON.stringify(list));
    } catch {}
  }
  function addKey() {
    const v = draft.trim();
    if (!v) return;
    if (filterList.some((k) => k.toLowerCase() === v.toLowerCase())) {
      setDraft("");
      return;
    }
    persist([...filterList, v]);
    setDraft("");
  }
  function removeKey(idx) {
    persist(filterList.filter((_, i) => i !== idx));
  }

  // Loại trừ: danh sách key món KHÔNG muốn hiện (dễ thêm/xóa từng key).
  // Rỗng = không loại gì. Lưu localStorage. Áp dụng SAU filter "chỉ hiện"
  // nên exclude luôn thắng include — tiện setup: include rộng + exclude hẹp.
  const [excludeList, setExcludeList] = useState(() => {
    try {
      const raw = localStorage.getItem("kds-exclude-list");
      if (raw) {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
      }
      return [];
    } catch {
      return [];
    }
  });
  const [excludeDraft, setExcludeDraft] = useState("");

  function persistExclude(list) {
    setExcludeList(list);
    try {
      localStorage.setItem("kds-exclude-list", JSON.stringify(list));
    } catch {}
  }
  function addExclude() {
    const v = excludeDraft.trim();
    if (!v) return;
    if (excludeList.some((k) => k.toLowerCase() === v.toLowerCase())) {
      setExcludeDraft("");
      return;
    }
    persistExclude([...excludeList, v]);
    setExcludeDraft("");
  }
  function removeExclude(idx) {
    persistExclude(excludeList.filter((_, i) => i !== idx));
  }

  // Viết tắt tên món: dictionary [{k, v}]. Key là 1 keyword hoặc nhiều
  // keyword cách nhau dấu phẩy (vd "không topping, ớt"). Tên món chứa key
  // (1 keyword) hoặc chứa ĐỦ HẾT các keyword (nhiều keyword, không phân biệt
  // hoa thường, không cần đúng thứ tự) thì CẢ TÊN được thay bằng value.
  // Áp dụng chung vòng lặp hiển thị với filter. Data gốc giữ nguyên.
  const [abbrList, setAbbrList] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem("kds-abbr-list") || "[]");
      if (Array.isArray(v)) return v.filter((e) => e && typeof e.k === "string" && typeof e.v === "string");
      return [];
    } catch {
      return [];
    }
  });
  const [abbrK, setAbbrK] = useState("");
  const [abbrV, setAbbrV] = useState("");

  function persistAbbr(list) {
    setAbbrList(list);
    try {
      localStorage.setItem("kds-abbr-list", JSON.stringify(list));
    } catch {}
  }
  function addAbbr() {
    const k = abbrK.trim();
    const v = abbrV.trim();
    if (!k || !v) return;
    const i = abbrList.findIndex((e) => e.k.toLowerCase() === k.toLowerCase());
    if (i >= 0) {
      // Key đã có thì cập nhật value = edit
      const next = abbrList.slice();
      next[i] = { k: next[i].k, v };
      persistAbbr(next);
    } else {
      persistAbbr([...abbrList, { k, v }]);
    }
    setAbbrK("");
    setAbbrV("");
  }
  function removeAbbr(idx) {
    persistAbbr(abbrList.filter((_, i) => i !== idx));
  }
  // Đổi thứ tự quy tắc viết tắt (quy tắc ở TRÊN được ưu tiên khớp trước).
  // Kéo tay cầm ☰ bằng Pointer Events nên chạy chung cả chuột lẫn cảm ứng
  // (HTML5 draggable cũ chỉ nhận chuột). Trong lúc kéo không reorder state,
  // chỉ đẩy chip theo tay + viền đứt ở vị trí sẽ thả; thả ra mới chốt 1 lần.
  const abbrItemRefs = useRef([]);
  const abbrDrag = useRef(null);
  function abbrSnapshot() {
    return abbrItemRefs.current.map((el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height };
    });
  }
  function abbrTargetFromY(rects, fromIdx, y) {
    let pos = 0;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (!r) continue;
      if (y > r.top + r.height / 2) pos = i + 1;
      else break;
    }
    return pos > fromIdx ? pos - 1 : pos;
  }
  function clearAbbrDragVisual() {
    abbrItemRefs.current.forEach((el) => {
      if (!el) return;
      el.style.transform = "";
      el.classList.remove("kds-chip-dragging", "kds-chip-drop");
    });
  }
  function onAbbrHandleDown(e, idx) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    abbrDrag.current = { idx, startY: e.clientY, moved: false, target: idx, rects: abbrSnapshot() };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }
  function onAbbrHandleMove(e, idx) {
    const t = abbrDrag.current;
    if (!t || t.idx !== idx) return;
    const dy = e.clientY - t.startY;
    if (!t.moved && Math.abs(dy) < 6) return; // ngưỡng: dưới 6px coi như chạm thường
    const el = abbrItemRefs.current[t.idx];
    if (!t.moved) {
      t.moved = true;
      if (el) el.classList.add("kds-chip-dragging");
    }
    if (el) el.style.transform = `translateY(${dy}px)`;
    const target = abbrTargetFromY(t.rects, t.idx, e.clientY);
    if (target !== t.target) {
      t.target = target;
      abbrItemRefs.current.forEach((n, i) => {
        if (n) n.classList.toggle("kds-chip-drop", i === target && target !== t.idx);
      });
    }
  }
  function onAbbrHandleUp(e, idx) {
    const t = abbrDrag.current;
    abbrDrag.current = null;
    if (!t || t.idx !== idx) { clearAbbrDragVisual(); return; }
    const { target, moved, idx: from } = t;
    clearAbbrDragVisual();
    if (moved && target !== from) moveAbbr(from, target);
  }
  function moveAbbr(from, to) {
    if (from === to || to < 0 || to >= abbrList.length) return;
    const next = abbrList.slice();
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    persistAbbr(next);
  }
  function matchAbbr(name) {
    const original = name || "";
    const lower = original.toLowerCase();
    for (const e of abbrList) {
      if (!e.k) continue;
      const parts = e.k.split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      if (parts.every((p) => lower.includes(p.toLowerCase()))) return e.v;
    }
    return null;
  }
  function abbreviate(name) {
    const v = matchAbbr(name);
    return v !== null ? v : name || "";
  }

  // Nút "Kế": bấm thì chụp m đơn đầu tiên đang hiển thị và làm nổi bật
  // đúng các đơn đó (lưu theo id). Hoàn thành đơn KHÔNG tự đẩy đơn tiếp
  // theo lên — chỉ bấm Kế mới chụp lại. m chỉnh 1-10. Lưu localStorage.
  const [nextCount, setNextCount] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem("kds-next-count") || "3", 10);
      return Math.min(10, Math.max(1, Number.isInteger(v) ? v : 3));
    } catch {
      return 3;
    }
  });
  const [pinnedIds, setPinnedIds] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem("kds-next-pinned") || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  });
  // Ghim đơn VIP: bấm 📌 ở góc trái card để đẩy đơn lên đầu, bấm lại để gỡ.
  const [pinTops, setPinTops] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem("kds-pin-top") || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  });

  function togglePinTop(id) {
    setPinTops((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        localStorage.setItem("kds-pin-top", JSON.stringify(next));
      } catch {}
      return next;
    });
  }
  const [statsOpen, setStatsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [configMsg, setConfigMsg] = useState("");

  // --- Thông báo đơn mới ---
  // Kêu + toast + rung + nháy tiêu đề khi socket báo order:new (đơn THÔ,
  // chưa qua filter include/exclude — bếp cần biết mọi đơn).
  // Lưu ý trung thực: browser bị thu nhỏ/tắt màn hình trên điện thoại thì
  // tab nền bị treo, socket ngắt → KHÔNG báo được. Muốn báo nền thật phải
  // làm Web Push (PWA + HTTPS + VAPID) ở bước sau.
  const [soundOn, setSoundOn] = useState(() => {
    try { return localStorage.getItem("kds-sound") !== "0"; } catch { return true; }
  });
  const [wakeOn, setWakeOn] = useState(() => {
    try { return localStorage.getItem("kds-wake") !== "0"; } catch { return true; }
  });
  const [notifPerm, setNotifPerm] = useState(() =>
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const [toasts, setToasts] = useState([]);
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;
  const notifRef = useRef(notifPerm);
  notifRef.current = notifPerm;
  const seenRef = useRef(new Set());
  const audioRef = useRef(null);
  const wakeRef = useRef(null);
  const flashTimer = useRef(null);

  function toggleSound() {
    const v = !soundOn;
    setSoundOn(v);
    try { localStorage.setItem("kds-sound", v ? "1" : "0"); } catch {}
    if (v) playAlert(); // thử kêu ngay để kiểm tra
  }
  function toggleWake() {
    const v = !wakeOn;
    setWakeOn(v);
    try { localStorage.setItem("kds-wake", v ? "1" : "0"); } catch {}
  }

  function ensureAudio() {
    try {
      if (!audioRef.current) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioRef.current = new AC();
      }
      if (audioRef.current.state === "suspended") audioRef.current.resume();
      return audioRef.current;
    } catch { return null; }
  }
  function playAlert() {
    const ctx = ensureAudio();
    if (!ctx) return;
    try {
      // 2 nhịp ting-tong: cao trước, trầm sau
      const notes = [
        { t: 0, f: 988 },   // ting (B5)
        { t: 0.35, f: 659 } // tong (E5)
      ];
      const now = ctx.currentTime;
      notes.forEach(({ t, f }) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0.001, now + t);
        g.gain.exponentialRampToValueAtTime(0.5, now + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, now + t + 0.3);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(now + t);
        o.stop(now + t + 0.32);
      });
    } catch {}
  }
  function pushToast(text) {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { id, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }
  function flashTitle() {
    const orig = "KDS - Bếp";
    let n = 0;
    if (flashTimer.current) clearInterval(flashTimer.current);
    flashTimer.current = setInterval(() => {
      document.title = n % 2 === 0 ? "🔔 ĐƠN MỚI!" : orig;
      if (++n >= 6) {
        clearInterval(flashTimer.current);
        flashTimer.current = null;
        document.title = orig;
      }
    }, 700);
  }
  function notifyOrder(order) {
    const qty = (order.items || []).reduce((s, it) => s + (it.quantity || 0), 0);
    const label = `Đơn mới #${order.sequenceNumber ?? ""} (${order.orderCode ?? ""})`;
    if (soundRef.current) playAlert();
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch {}
    pushToast(`🔔 ${label} — ${qty} món`);
    flashTitle();
    try {
      if (notifRef.current === "granted" && document.hidden) {
        new Notification(label, {
          body: `Tổng ${qty} món — bấm để mở bếp`,
          tag: order.id
        });
      }
    } catch {}
  }
  async function enableBrowserNotif() {
    try {
      if (typeof Notification === "undefined") {
        setConfigMsg("Thiết bị này không hỗ trợ Notification");
        return;
      }
      const p = await Notification.requestPermission();
      setNotifPerm(p);
      if (p === "granted") {
        setConfigMsg("Đã bật thông báo hệ thống (chỉ hiện khi tab chạy nền)");
        try {
          new Notification("KDS đã bật thông báo", {
            body: "Đơn mới sẽ báo ngay cả khi tab chạy nền (browser còn mở)."
          });
        } catch {}
      } else {
        setConfigMsg("Chưa được cấp quyền thông báo");
      }
    } catch {}
  }

  // Mở khóa audio sau chạm đầu tiên (chính sách autoplay của browser chặn
  // tiếng kêu trước khi người dùng tương tác trang lần nào).
  useEffect(() => {
    const unlock = () => ensureAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  // Giữ màn hình sáng (Wake Lock) cho máy bếp luôn bật. Mất khi tab ẩn,
  // xin lại khi mở lên. Browser không hỗ trợ thì bỏ qua êm.
  async function requestWake() {
    try {
      if (!("wakeLock" in navigator)) return;
      if (document.hidden) return;
      if (wakeRef.current) return;
      wakeRef.current = await navigator.wakeLock.request("screen");
      wakeRef.current.addEventListener?.("release", () => { wakeRef.current = null; });
    } catch {}
  }
  useEffect(() => {
    if (!wakeOn) {
      try { wakeRef.current?.release(); } catch {}
      wakeRef.current = null;
      return;
    }
    requestWake();
    const onVis = () => { if (!document.hidden) requestWake(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [wakeOn]);

  // Xuất / nhập cấu hình chung (filter, viết tắt, cỡ card, đơn kế)
  // để setup nhanh máy mới thay vì nhập tay từng món.
  function exportConfig() {
    const cfg = {
      app: "kds-client",
      version: 1,
      exportedAt: new Date().toISOString(),
      filterList,
      excludeList,
      soundOn,
      wakeOn,
      statsCols,
      abbrList,
      cardSize,
      customCols,
      nextCount
    };
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kds-config.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setConfigMsg("Đã xuất file kds-config.json");
  }

  function importConfig(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const cfg = JSON.parse(rd.result);
        if (!cfg || typeof cfg !== "object") throw new Error("File không đúng định dạng");
        if (Array.isArray(cfg.filterList)) {
          persist(cfg.filterList.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean));
        }
        if (Array.isArray(cfg.excludeList)) {
          persistExclude(cfg.excludeList.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean));
        }
        if (Array.isArray(cfg.abbrList)) {
          persistAbbr(
            cfg.abbrList
              .filter((x) => x && typeof x.k === "string" && typeof x.v === "string")
              .map((x) => ({ k: x.k.trim(), v: x.v.trim() }))
              .filter((x) => x.k && x.v)
          );
        }
        if (["small", "medium", "large", "custom"].includes(cfg.cardSize)) changeCardSize(cfg.cardSize);
        if (cfg.customCols !== undefined) changeCustomCols(parseInt(cfg.customCols, 10));
        if (cfg.nextCount !== undefined) changeNextCount(parseInt(cfg.nextCount, 10));
        if (cfg.soundOn !== undefined) {
          const v = cfg.soundOn !== false && cfg.soundOn !== "0";
          setSoundOn(v);
          try { localStorage.setItem("kds-sound", v ? "1" : "0"); } catch {}
        }
        if (cfg.wakeOn !== undefined) {
          const v = cfg.wakeOn !== false && cfg.wakeOn !== "0";
          setWakeOn(v);
          try { localStorage.setItem("kds-wake", v ? "1" : "0"); } catch {}
        }
        if (cfg.statsCols !== undefined) changeStatsCols(parseInt(cfg.statsCols, 10));
        setConfigMsg("Nhập cấu hình xong");
      } catch (err) {
        setConfigMsg("Lỗi: " + (err.message || "không đọc được file"));
      }
    };
    rd.readAsText(f);
  }
  // Cỡ card: small = 3 card/hàng (gọn), medium = 2 card/hàng, large = 1 card/hàng,
  // custom = số cột tùy chọn 1-8.
  const [cardSize, setCardSize] = useState(() => {
    try {
      const v = localStorage.getItem("kds-card-size") || "medium";
      return ["small", "medium", "large", "custom"].includes(v) ? v : "medium";
    } catch {
      return "medium";
    }
  });
  const [customCols, setCustomCols] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem("kds-card-cols") || "4", 10);
      return Math.min(8, Math.max(1, Number.isInteger(v) ? v : 4));
    } catch {
      return 4;
    }
  });

  function changeCardSize(v) {
    setCardSize(v);
    try {
      localStorage.setItem("kds-card-size", v);
    } catch {}
  }
  function changeCustomCols(v) {
    const n = Math.min(8, Math.max(1, Number.isNaN(v) ? 1 : v));
    setCustomCols(n);
    try {
      localStorage.setItem("kds-card-cols", String(n));
    } catch {}
  }

  // Số cột của bảng thống kê (1-3, mặc định 2 cho gọn). Lưu localStorage.
  const [statsCols, setStatsCols] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem("kds-stats-cols") || "2", 10);
      return Math.min(3, Math.max(1, Number.isInteger(v) ? v : 2));
    } catch {
      return 2;
    }
  });
  function changeStatsCols(v) {
    const n = Math.min(3, Math.max(1, Number.isNaN(v) ? 1 : v));
    setStatsCols(n);
    try {
      localStorage.setItem("kds-stats-cols", String(n));
    } catch {}
  }

  // Style grid: cột custom qua inline. Mỗi card có rộng tối thiểu
  // (minmax) — hết chỗ thì cuộn ngang, không bóp méo nội dung.
  const gridStyle =
    cardSize === "custom"
      ? { gridTemplateColumns: "repeat(" + Math.min(8, Math.max(1, customCols)) + ", minmax(230px, 1fr))" }
      : {};
  const gridClass = "kds-grid" + (cardSize === "custom" ? "" : " kds-grid-" + cardSize);

  function changeNextCount(v) {
    const n = Math.min(10, Math.max(1, Number.isNaN(v) ? 1 : v));
    setNextCount(n);
    try {
      localStorage.setItem("kds-next-count", String(n));
    } catch {}
  }

  useEffect(() => {
    // 1. Load danh sách ban đầu (gồm cả completed, client tự lọc khi render)
    fetch(`${SERVER_URL}/api/orders`)
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : data.orders || [];
        list.forEach((o) => seenRef.current.add(o.id)); // có sẵn = không kêu
        setOrders(list);
      })
      .catch((e) => console.error("GET /api/orders lỗi:", e));

    // 2. Kết nối realtime
    const socket = io(SERVER_URL);
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    // 3. Đơn mới -> kêu + toast, rồi append cuối danh sách
    socket.on("order:new", (order) => {
      if (!seenRef.current.has(order.id)) {
        seenRef.current.add(order.id);
        notifyOrder(order);
      }
      setOrders((prev) => (prev.some((o) => o.id === order.id) ? prev : [...prev, order]));
    });

    // 4. Đơn hoàn thành -> cập nhật status
    socket.on("order:completed", ({ id }) => {
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: "completed" } : o)));
    });

    // 4c. Đơn hoàn tác từ server -> về đang chờ, hiện lại trên bếp
    socket.on("order:reopened", ({ id }) => {
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: "pending" } : o)));
    });

    // 4b. Đơn bị xóa từ trang quản lý server -> gỡ khỏi state
    socket.on("order:deleted", ({ id }) => {
      setOrders((prev) => prev.filter((o) => o.id !== id));
      setPinnedIds((prev) => prev.filter((x) => x !== id));
      setPinTops((prev) => prev.filter((x) => x !== id));
    });

    return () => socket.disconnect();
  }, []);

  // 5. Bấm hoàn thành: chỉ gọi PATCH, chờ socket emit về mới update UI
  async function handleComplete(id) {
    try {
      await fetch(`${SERVER_URL}/api/orders/${id}/complete`, { method: "PATCH" });
    } catch (e) {
      console.error("PATCH complete lỗi:", e);
    }
  }

  // Đơn completed: ẩn khỏi grid chính, giữ trong state.
  // + Lọc món trong từng card theo 2 lớp:
  //   1. include (filterList): rỗng = giữ tất cả, có key = chỉ giữ món chứa key.
  //   2. exclude (excludeList): loại món chứa key (luôn thắng include).
  // (không phân biệt hoa thường). SL cạnh giờ = tổng SL sau cả 2 lớp lọc.
  // Đơn không còn món nào sau lọc thì ẩn cả card.
  const keys = filterList.map((k) => k.toLowerCase());
  const exKeys = excludeList.map((k) => k.toLowerCase());
  const visible = orders
    .filter((o) => o.status !== "completed")
    .map((o) => {
      let items = keys.length === 0
        ? o.items || []
        : (o.items || []).filter((it) =>
            keys.some((k) => (it.name || "").toLowerCase().includes(k))
          );
      if (exKeys.length > 0) {
        items = items.filter(
          (it) => !exKeys.some((k) => (it.name || "").toLowerCase().includes(k))
        );
      }
      // Filter theo tên gốc, rồi rút gọn tên để hiển thị
      const displayItems = items.map((it) => ({ ...it, displayName: abbreviate(it.name) }));
      const filteredQty = items.reduce((s, it) => s + (it.quantity || 0), 0);
      return { ...o, displayItems, displayQty: filteredQty };
    })
    .filter((o) => o.displayItems.length > 0)
    // Đơn ghim 📌 lên đầu (giữa các đơn ghim xếp theo số thứ tự)
    .sort((a, b) => {
      const pa = pinTops.includes(a.id) ? 0 : 1;
      const pb = pinTops.includes(b.id) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (a.sequenceNumber || 0) - (b.sequenceNumber || 0);
    });

  // Bấm Kế: chụp m đơn đầu tiên đang hiển thị (theo id).
  // Hoàn thành đơn không tự đẩy — chỉ bấm Kế mới chụp lại.
  // Giữ lâu nút Kế (~0.6s) để tắt nổi bật khi đơn ít không cần nữa.
  const pressTimer = useRef(null);
  const longFired = useRef(false);
  function clearNext() {
    setPinnedIds([]);
    try {
      localStorage.setItem("kds-next-pinned", "[]");
    } catch {}
  }

  function handleNext() {
    const ids = visible.slice(0, nextCount).map((o) => o.id);
    setPinnedIds(ids);
    try {
      localStorage.setItem("kds-next-pinned", JSON.stringify(ids));
    } catch {}
  }

  function kePressStart() {
    longFired.current = false;
    pressTimer.current = setTimeout(() => {
      longFired.current = true;
      clearNext();
    }, 600);
  }
  function kePressEnd() {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }
  function keClick() {
    if (longFired.current) {
      longFired.current = false;
      return;
    }
    handleNext();
  }

  // Thống kê (liên kết bảng viết tắt): gom SL theo value đang áp dụng,
  // trên các đơn đang hiển thị. Món không khớp quy tắc nào thì không tính.
  const statsMap = new Map();
  visible.forEach((o) => {
    (o.displayItems || []).forEach((it) => {
      const v = matchAbbr(it.name);
      if (v === null) return;
      statsMap.set(v, (statsMap.get(v) || 0) + (it.quantity || 0));
    });
  });
  const stats = Array.from(statsMap.entries())
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));

  return (
    <div className="kds-page">
      <header className="kds-topbar">
        <span className="kds-logo">🍳</span>
        <span className={connected ? "badge-online" : "badge-offline"}>
          {connected ? "●" : "○"}
        </span>
        <button
          className="btn-next"
          onClick={keClick}
          onMouseDown={kePressStart}
          onMouseUp={kePressEnd}
          onMouseLeave={kePressEnd}
          onTouchStart={kePressStart}
          onTouchEnd={kePressEnd}
          title={"Bấm: nổi bật " + nextCount + " đơn đầu • Giữ lâu: tắt"}
        >
          {pinnedIds.length > 0 ? "Kế (" + pinnedIds.length + ")" : "Kế"}
        </button>
        <button
          className="kds-topbtn"
          onClick={toggleSound}
          title={soundOn ? "Tắt chuông báo đơn mới" : "Bật chuông báo đơn mới"}
        >
          {soundOn ? "🔔" : "🔕"}
        </button>
        <button className="kds-topbtn" onClick={() => setStatsOpen((v) => !v)} title="Thống kê">
          📊{statsOpen ? " ▾" : ""}
        </button>
        <span className="kds-spacer" />
        <span className="kds-settings-hint">Tổng {visible.length} đơn</span>
        <button className="kds-topbtn" onClick={() => setSettingsOpen(true)} title="Thiết lập">
          ⚙️ Thiết lập
        </button>
      </header>

      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b>⚙️ Thiết lập</b>
              <button className="kds-chip-x" onClick={() => setSettingsOpen(false)} title="Đóng">
                ×
              </button>
            </div>

            <section className="kds-settings">
              <label className="kds-settings-label">⏭️ Số lượng đơn kế (m):</label>
              <input
                className="kds-next-input"
                type="number"
                min={1}
                max={10}
                value={nextCount}
                onChange={(e) => changeNextCount(parseInt(e.target.value, 10))}
              />
              <span className="kds-settings-hint">(1-10)</span>
            </section>

            <section className="kds-settings">
              <label className="kds-settings-label">🔔 Báo đơn mới:</label>
              <button
                className={soundOn ? "btn-next" : "kds-settings-clear"}
                onClick={toggleSound}
                title="Kêu ting-tong + toast + rung khi có đơn mới"
              >
                {soundOn ? "🔊 Đang bật" : "🔇 Đang tắt"}
              </button>
              <button
                className={wakeOn ? "btn-next" : "kds-settings-clear"}
                onClick={toggleWake}
                title="Giữ màn hình luôn sáng cho máy bếp"
              >
                {wakeOn ? "📱 Giữ sáng: bật" : "📱 Giữ sáng: tắt"}
              </button>
              {notifPerm === "granted" ? (
                <span className="kds-settings-hint">✔️ Đã cho phép thông báo hệ thống</span>
              ) : (
                <button className="kds-settings-clear" onClick={enableBrowserNotif}>
                  Bật thông báo hệ thống
                </button>
              )}
              <span className="kds-settings-hint">
                Thu nhỏ browser / tắt màn hình điện thoại thì tab nền bị treo, socket ngắt → không báo được.
                Muốn báo nền thật cần Web Push (làm sau).
                {!("wakeLock" in navigator) && " Máy này không hỗ trợ giữ sáng tự động."}
              </span>
            </section>

            <section className="kds-settings">
              <label className="kds-settings-label">📐 Cỡ card:</label>
              {[
                ["small", "Nhỏ (3/hàng)"],
                ["medium", "Vừa (2/hàng)"],
                ["large", "Lớn (1/hàng)"]
              ].map(([v, label]) => (
                <button
                  key={v}
                  className={cardSize === v ? "btn-next" : "kds-settings-clear"}
                  onClick={() => changeCardSize(v)}
                >
                  {label}
                </button>
              ))}
              <button
                className={cardSize === "custom" ? "btn-next" : "kds-settings-clear"}
                onClick={() => changeCardSize("custom")}
              >
                Tùy chỉnh
              </button>
              {cardSize === "custom" && (
                <input
                  className="kds-next-input"
                  type="number"
                  min={1}
                  max={8}
                  value={customCols}
                  onChange={(e) => changeCustomCols(parseInt(e.target.value, 10))}
                  title="Số card mỗi hàng (1-8)"
                />
              )}
            </section>

            <section className="kds-settings">
              <label className="kds-settings-label">📊 Số cột thống kê:</label>
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  className={statsCols === n ? "btn-next" : "kds-settings-clear"}
                  onClick={() => changeStatsCols(n)}
                >
                  {n} cột
                </button>
              ))}
              <span className="kds-settings-hint">(bảng 📊 trên trang chính)</span>
            </section>

            <section className="kds-settings">
              <label className="kds-settings-label">🔎 Chỉ hiện món chứa:</label>
              <input
                className="kds-settings-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addKey();
                }}
                placeholder="vd: gà nướng (Enter để thêm, để trống = hiện tất cả)"
              />
              <button className="kds-settings-clear" onClick={addKey}>
                Thêm
              </button>
              {filterList.length > 0 && (
                <button className="kds-settings-clear" onClick={() => persist([])}>
                  Xóa hết
                </button>
              )}
              <div className="kds-chips">
                {filterList.map((k, i) => (
                  <span className="kds-chip" key={i}>
                    {k}
                    <button className="kds-chip-x" onClick={() => removeKey(i)} title="Xóa">
                      ×
                    </button>
                  </span>
                ))}
                {filterList.length === 0 && (
                  <span className="kds-settings-hint">Đang hiện tất cả món</span>
                )}
              </div>
            </section>

            <section className="kds-settings">
              <label className="kds-settings-label">🚫 Loại trừ món chứa:</label>
              <input
                className="kds-settings-input"
                value={excludeDraft}
                onChange={(e) => setExcludeDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addExclude();
                }}
                placeholder="vd: mang về (Enter để thêm, để trống = không loại gì)"
              />
              <button className="kds-settings-clear" onClick={addExclude}>
                Thêm
              </button>
              {excludeList.length > 0 && (
                <button className="kds-settings-clear" onClick={() => persistExclude([])}>
                  Xóa hết
                </button>
              )}
              <div className="kds-chips">
                {excludeList.map((k, i) => (
                  <span className="kds-chip" key={i}>
                    {k}
                    <button className="kds-chip-x" onClick={() => removeExclude(i)} title="Xóa">
                      ×
                    </button>
                  </span>
                ))}
                {excludeList.length === 0 && (
                  <span className="kds-settings-hint">Không loại món nào</span>
                )}
              </div>
            </section>

            <section className="kds-settings">
              <label className="kds-settings-label">📝 Viết tắt tên món:</label>
              <input
                className="kds-settings-input"
                value={abbrK}
                onChange={(e) => setAbbrK(e.target.value)}
                placeholder="Tên gốc hoặc nhiều keyword cách nhau dấu phẩy"
              />
              <input
                className="kds-settings-input"
                value={abbrV}
                onChange={(e) => setAbbrV(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addAbbr();
                }}
                placeholder="Tên tắt (vd: Nhĩ)"
              />
              <button className="kds-settings-clear" onClick={addAbbr}>
                Thêm
              </button>
              {abbrList.length > 0 && (
                <button className="kds-settings-clear" onClick={() => persistAbbr([])}>
                  Xóa hết
                </button>
              )}
              <div className="kds-chips kds-chips-col">
                {abbrList.map((e, i) => (
                  <span
                    className="kds-chip"
                    key={i}
                    ref={(el) => { abbrItemRefs.current[i] = el; }}
                  >
                    <span
                      className="kds-drag"
                      title="Nhấn giữ rồi kéo để đổi thứ tự (trên ưu tiên trước)"
                      onPointerDown={(ev) => onAbbrHandleDown(ev, i)}
                      onPointerMove={(ev) => onAbbrHandleMove(ev, i)}
                      onPointerUp={(ev) => onAbbrHandleUp(ev, i)}
                      onPointerCancel={() => { abbrDrag.current = null; clearAbbrDragVisual(); }}
                      onContextMenu={(ev) => ev.preventDefault()}
                    >
                      ☰
                    </span>
                    <span className="kds-abbr-text">{e.k} → {e.v}</span>
                    <button className="kds-chip-x" onClick={() => removeAbbr(i)} title="Xóa">
                      ×
                    </button>
                  </span>
                ))}
                {abbrList.length === 0 && (
                  <span className="kds-settings-hint">Chưa có quy tắc viết tắt</span>
                )}
                {abbrList.length > 0 && (
                  <span className="kds-settings-hint">
                    Kéo ☰ để đổi thứ tự — dùng được cả chuột và cảm ứng.
                    Quy tắc ở trên khớp trước.
                    Key nhiều keyword cách nhau dấu phẩy phải khớp đủ hết mới rút gọn
                  </span>
                )}
              </div>
            </section>
            <section className="kds-settings">
              <label className="kds-settings-label">💾 Cấu hình chung:</label>
              <button className="kds-settings-clear" onClick={exportConfig}>
                Xuất file
              </button>
              <label className="kds-settings-clear" style={{ cursor: "pointer" }}>
                Nhập file
                <input type="file" accept=".json,application/json" hidden onChange={importConfig} />
              </label>
              {configMsg && <span className="kds-settings-hint">{configMsg}</span>}
            </section>

            <section className="kds-settings">
              <label className="kds-settings-label">📱 Mở trên thiết bị khác:</label>
              <span className="kds-settings-hint">{getClientLanUrl()}</span>
              <button className="kds-settings-clear" onClick={() => setQrOpen(true)}>
                Hiện mã QR
              </button>
            </section>
          </div>
        </div>
      )}

      {qrOpen && (
        <div className="qr-overlay" onClick={() => setQrOpen(false)}>
          <div className="qr-box" onClick={(e) => e.stopPropagation()}>
            <b>📱 Quét để mở KDS</b>
            <QRCodeSVG value={getClientLanUrl()} size={220} />
            <span className="kds-settings-hint">{getClientLanUrl()}</span>
            <button className="kds-settings-clear" onClick={() => setQrOpen(false)}>
              Đóng
            </button>
          </div>
        </div>
      )}
      {statsOpen && (
        <section className="kds-stats" style={{ gridTemplateColumns: "repeat(" + statsCols + ", 1fr)" }}>
          {stats.length === 0 ? (
            <span className="kds-settings-hint" style={{ gridColumn: "1 / -1" }}>
              Không có món nào khớp bảng viết tắt
            </span>
          ) : (
            stats.map((s) => (
              <div className="kds-item kds-stat-cell" key={s.name}>
                • {s.name} - {s.qty}
              </div>
            ))
          )}
        </section>
      )}

      {toasts.length > 0 && (
        <div className="kds-toasts">
          {toasts.map((t) => (
            <div className="kds-toast" key={t.id}>
              {t.text}
            </div>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="kds-empty">Chưa có đơn nào. Chờ extension gửi lên...</p>
      ) : (
        <div className="grid-wrap">
        <div className={gridClass} style={gridStyle}>
          {visible.map((o) => (
            <div
              className={pinnedIds.includes(o.id) ? "kds-card kds-card-next" : "kds-card"}
              key={o.id}
            >
              <div className="kds-card-top">
                <div className="kds-card-left">
                  <button
                    className={pinTops.includes(o.id) ? "pin-btn pin-on" : "pin-btn pin-off"}
                    onClick={() => togglePinTop(o.id)}
                    title={pinTops.includes(o.id) ? "Gỡ ghim (bỏ ưu tiên)" : "Ghim lên đầu (ưu tiên)"}
                  >
                    📌
                  </button>
                  <span className="seq">{padSeq(o.sequenceNumber)}</span>
                  <span className="code">{o.orderCode}</span>
                </div>
                <div className="kds-card-right">
                  <span className="time">{fmtTime(o.receivedAt)}</span>
                  <span className="qty">{o.displayQty}</span>
                </div>
              </div>
              <div className="kds-items">
                {o.displayItems.map((it, idx) => (
                  <div
                    className="kds-item"
                    key={idx}
                    title={it.displayName !== it.name ? it.name : undefined}
                  >
                    • {it.displayName} - {it.quantity}
                  </div>
                ))}
              </div>
              <div className="kds-card-bottom">
                <button className="btn-complete" onClick={() => handleComplete(o.id)}>
                  Hoàn thành
                </button>
              </div>
            </div>
          ))}
        </div>
        </div>
      )}
    </div>
  );
}
