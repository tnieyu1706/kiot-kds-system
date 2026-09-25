const input = document.getElementById("serverUrl");
const status = document.getElementById("status");

chrome.storage.local.get(["serverUrl"], (res) => {
  if (res.serverUrl) input.value = res.serverUrl;
});

document.getElementById("save").onclick = () => {
  const v = input.value.trim().replace(/\/$/, "") || "http://localhost:3000";
  chrome.storage.local.set({ serverUrl: v }, () => {
    status.textContent = "Đã lưu: " + v;
  });
};

document.getElementById("test").onclick = async () => {
  const base = input.value.trim().replace(/\/$/, "") || "http://localhost:3000";
  status.textContent = "Đang test " + base + "/health ...";
  try {
    // Qua background de bypass PNA/CORS, giong content.js
    const res = await chrome.runtime.sendMessage({
      type: "KV_HEALTH_CHECK",
      serverUrl: base
    });
    if (res?.ok) status.textContent = "OK ✅: " + JSON.stringify(res.data);
    else status.textContent = "Lỗi ❌: " + res?.error + "\n(Server đã chạy chưa?)";
  } catch (e) {
    status.textContent = "Lỗi ❌: " + e.message + "\n(Server đã chạy chưa?)";
  }
};
