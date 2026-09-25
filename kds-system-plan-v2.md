# Kế hoạch triển khai hệ thống KDS (Kitchen Display System)

## 1. Tổng quan

Hệ thống gồm 3 thành phần:

1. **Extension (đã có sẵn)** — nhúng vào trang cashier của KiotViet (`fnb.kiotviet.vn/.../pos/#/cashier`), đọc dữ liệu đơn hàng từ DOM và gửi lên KDS Server. Luồng dữ liệu chỉ **1 chiều**: Cashier Web → KDS Server. Extension không nhận phản hồi/lệnh gì ngược lại từ KDS.
2. **KDS Server** — Node.js, nhận đơn từ extension, chuẩn hóa dữ liệu, lưu tạm trong RAM, phát realtime cho các client, xử lý cập nhật trạng thái đơn.
3. **KDS Client** — React (web app, responsive để dùng được trên điện thoại/tablet), hiển thị danh sách đơn dạng card cho bếp theo dõi và tương tác (đánh dấu hoàn thành). Nhiều thiết bị có thể cùng mở client này song song, tất cả đồng bộ realtime qua server.

Luồng dữ liệu:

```
[Cashier Web + Extension] --POST đơn mới--> [KDS Server (RAM)] --emit realtime--> [KDS Client (React, nhiều thiết bị)]
                                                  ^                                        |
                                                  |______PATCH hoàn thành (từ bất kỳ thiết bị nào)______|
```

---

## 2. Dữ liệu đầu vào (Extension → Server)

Extension gửi JSON dạng:

```json
{
  "orderCode": "7925",
  "items": [
    { "name": "Nhĩ: O", "quantity": 1 },
    { "name": "Chanh: X", "quantity": 2 }
  ]
}
```

Ghi chú:
- `orderCode`: mã đơn lấy từ trang cashier.
- `items[].name`: **tên sản phẩm đã gộp topping thành 1 chuỗi hoàn chỉnh** (ví dụ "Nhĩ: O", "Chanh: X" — đây coi như là "tên món" cuối cùng, không cần xử lý gì thêm ở server/client, chỉ hiển thị nguyên).
- `items[].quantity`: số lượng món.

---

## 3. KDS Server (Node.js)

### 3.1. Công nghệ
- Node.js + Express (REST API)
- Socket.IO (giao tiếp realtime với client)
- **Lưu trữ: in-memory** (array/object trong bộ nhớ Node process). Không dùng DB ở giai đoạn này. Dữ liệu sẽ mất khi server restart — chấp nhận được ở bản đầu tiên.

### 3.2. Cấu trúc dữ liệu đơn hàng nội bộ (server tự chuẩn hóa khi nhận từ extension)

```json
{
  "id": "uuid-tự-sinh",
  "sequenceNumber": 1,
  "orderCode": "7925",
  "receivedAt": "2026-09-24T17:32:00+07:00",
  "totalQuantity": 3,
  "items": [
    { "name": "Nhĩ: O", "quantity": 1 },
    { "name": "Chanh: X", "quantity": 2 }
  ],
  "status": "pending"
}
```

Quy tắc sinh field:
- `id`: uuid v4, sinh khi nhận đơn, dùng làm định danh nội bộ (để cập nhật trạng thái sau này).
- `sequenceNumber`: số tăng dần tự động theo thứ tự nhận đơn, bắt đầu từ 1 khi server khởi động (do lưu RAM nên số này tự nhiên reset mỗi khi restart server — không cần logic reset theo ngày riêng).
- `receivedAt`: thời điểm server nhận đơn (dùng để hiển thị giờ trên card).
- `totalQuantity`: tổng cộng dồn `quantity` của tất cả `items`.
- `status`: mặc định `"pending"` khi tạo mới; chuyển thành `"completed"` khi bếp bấm hoàn thành.

### 3.3. API cần triển khai

| Method | Endpoint | Mô tả |
|---|---|---|
| POST | `/api/orders` | Extension gọi để gửi đơn mới. Server validate, chuẩn hóa, lưu vào mảng trong RAM, emit `order:new` qua Socket.IO cho toàn bộ client đang kết nối. |
| GET | `/api/orders` | Client gọi khi vừa load trang, để lấy toàn bộ danh sách đơn hiện có trong RAM (đồng bộ trạng thái ban đầu trước khi nhận sự kiện realtime tiếp theo). |
| PATCH | `/api/orders/:id/complete` | Client gọi khi bếp bấm "Hoàn thành". Server tìm đơn theo `id` trong RAM, đổi `status` thành `"completed"`, emit `order:completed` cho toàn bộ client để các thiết bị khác cũng cập nhật theo. |

### 3.4. Sự kiện Socket.IO

| Sự kiện | Hướng | Payload | Mô tả |
|---|---|---|---|
| `order:new` | Server → tất cả Client | object đơn hàng đầy đủ (như mục 3.2) | Có đơn mới vừa nhận từ extension |
| `order:completed` | Server → tất cả Client | `{ id }` | Đơn đã được 1 thiết bị nào đó đánh dấu hoàn thành — các thiết bị khác cần cập nhật lại card tương ứng |

### 3.5. Xử lý lỗi cần có
- Validate payload từ extension: bắt buộc có `orderCode` (string không rỗng) và `items` (mảng không rỗng, mỗi phần tử có `name` và `quantity` hợp lệ). Nếu thiếu/sai, trả lỗi 400, không lưu vào RAM.
- Nếu client gọi `PATCH .../complete` với `id` không tồn tại trong RAM, trả lỗi 404.

---

## 4. KDS Client (React)

### 4.1. Công nghệ
- React (Vite khuyến nghị để build nhẹ, load nhanh trên điện thoại)
- `socket.io-client` để kết nối realtime tới server
- Thiết kế **responsive** — vì mục tiêu là chạy được trên cả điện thoại (bếp cầm xem) lẫn màn hình lớn cố định trong bếp.

### 4.2. Luồng hoạt động
1. Khi app mount: gọi `GET /api/orders` để lấy toàn bộ danh sách đơn hiện có (bao gồm cả đơn đã `completed`, để client tự lọc hiển thị theo nhu cầu), render lên trước.
2. Kết nối Socket.IO tới server.
3. Lắng nghe `order:new` → thêm card đơn mới vào danh sách state (append vào danh sách đang có).
4. Lắng nghe `order:completed` → tìm đơn theo `id` trong state, cập nhật `status` thành `"completed"`.
5. Khi bếp bấm nút "Hoàn thành" trên 1 card: gọi `PATCH /api/orders/:id/complete`. Không cần tự cập nhật UI ngay tại chỗ — chờ server emit lại `order:completed` để đảm bảo mọi thiết bị (kể cả chính thiết bị vừa bấm) đồng bộ theo cùng 1 nguồn dữ liệu.

### 4.3. Giao diện card (theo ảnh mẫu)

Mỗi card gồm:
- Góc trên trái: **số thứ tự** (`sequenceNumber`), nền màu hồng nhạt, hiển thị dạng số đệm 0 (ví dụ "001").
- Kế bên: **mã đơn** (`orderCode`), nền màu vàng nhạt.
- Góc trên phải: **giờ nhận đơn** (định dạng `HH:mm`, lấy từ `receivedAt`), kế bên là ô nền xanh dương chứa **tổng số món** (`totalQuantity`).
- Phần giữa: danh sách món, mỗi món 1 dòng trong khối bo góc riêng, hiển thị đúng định dạng:
  ```
  <tên món>: <số lượng>
  ```
  Ví dụ: `Chanh: X: 2` — nếu ra kết quả này bị trùng dấu `:` khó đọc (vì `name` gửi lên từ extension đã có dạng "Chanh: X" sẵn), có thể cân nhắc đổi cách nối thành `<tên món> - <số lượng>` để tránh 2 dấu `:` liền nhau (ví dụ "Chanh: X - 2" như trong ảnh mẫu gốc) — bạn xác nhận lại cách nối cuối cùng khi thấy giao diện thực tế, còn lại field `name` cứ giữ nguyên, không xử lý/tách gì thêm ở client.
- Góc dưới phải: nút **"Hoàn thành"**, nền xanh lá — bấm vào gọi API hoàn thành đơn (mục 4.2 bước 5).

### 4.4. Bố cục tổng thể trang KDS
- Hiển thị dạng lưới (grid) các card, đơn mới nhất thêm vào **cuối danh sách hiện có** (theo đúng thứ tự nhận, giống `sequenceNumber` tăng dần — bếp dễ theo dõi thứ tự làm món).
- Đơn đã `status = "completed"`: **ẩn khỏi danh sách hiển thị chính** (lọc bỏ trong lúc render), chỉ giữ trong state để không bị mất dữ liệu nếu sau này cần xem lại trong phiên làm việc hiện tại.

---

## 5. Việc phía Extension đảm nhiệm (đã triển khai, ghi lại để đồng bộ)

- Trích xuất `orderCode` từ phần tử `.customer-name a`.
- Trích xuất danh sách món từ `.product-cart-list .product-cart-item`, mỗi món lấy tên từ `.product-name-text` (bỏ số thứ tự đầu dòng như "1. ") và số lượng từ `.item-quantity`.
- Gộp topping từ `.list-topping` vào tên món, tạo ra chuỗi `name` hoàn chỉnh cuối cùng (không cần xử lý thêm ở server/client).
- Đóng gói thành JSON theo đúng cấu trúc mục 2, gửi `POST` tới `KDS Server` (`/api/orders`).
- Luồng 1 chiều: extension chỉ gửi đi, không cần nhận phản hồi hay lệnh gì ngược lại từ KDS Server.

---

## 6. Gợi ý thứ tự triển khai

1. Dựng KDS Server: setup Express + Socket.IO, mảng lưu đơn trong RAM.
2. Triển khai `POST /api/orders` (kèm validate) và `GET /api/orders`.
3. Test emit `order:new` bằng cách gọi `POST /api/orders` thủ công qua Postman, xác nhận Socket.IO client nhận được.
4. Triển khai `PATCH /api/orders/:id/complete` và emit `order:completed`.
5. Dựng KDS Client: kết nối Socket.IO, load danh sách ban đầu qua `GET /api/orders`, hiển thị card tĩnh (chưa cần đẹp) để test luồng realtime hoạt động đúng.
6. Chỉnh giao diện card đúng theo mẫu (màu sắc, bố cục, responsive cho điện thoại).
7. Nối extension thật vào cashier để gửi đơn tự động, test end-to-end toàn bộ luồng.

---

## 7. Còn 1 điểm nhỏ cần bạn xác nhận khi nhìn giao diện thực tế

Cách nối `<tên món>` và `<số lượng>` trong dòng hiển thị món — dùng dấu `:` hay dấu `-` — vì field `name` gửi lên đã có dạng "Chanh: X" sẵn (đã gồm dấu `:` bên trong), nếu nối thêm `: <số lượng>` sẽ ra "Chanh: X: 2" hơi khó đọc. Bạn xem thử khi build xong rồi quyết định đổi dấu nối cho đẹp cũng được, không ảnh hưởng gì đến các phần logic khác.
