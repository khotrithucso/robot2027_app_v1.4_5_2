# Robot 2027 — Phiên Bản V1.4 Pro (Update 4)

Dự án hoàn chỉnh đóng gói chuẩn **Capacitor Android + GitHub Actions** sẵn sàng import vào **Spck Editor** và tự động biên dịch file `.apk`.

## Những nâng cấp trong bản Update 4
1. **Bàn phím số 0–9 tích hợp sẵn & Mật khẩu đa năng mở Cài đặt:**
   - Tích hợp bàn phím số cảm ứng trực tiếp bên trong hộp thoại khóa Cài đặt (không bị lỗi ẩn phím khi chuyển sang số trên Laban Key).
   - Hỗ trợ đồng thời mã PIN Phụ huynh (`1234`), mã số nhanh (`202799`) và mật khẩu chữ (`robotrobot`).
2. **Gỡ bỏ xin quyền Ảnh, Video & Camera:**
   - Loại bỏ hoàn toàn `READ_MEDIA_IMAGES`, `READ_MEDIA_AUDIO`, `READ_EXTERNAL_STORAGE` và `CAMERA` để tránh hộp thoại hỏi quyền không cần thiết trên Android 13+.
3. **Hoàn thiện Quyền Ghim Ứng Dụng (Screen Pinning / Kiosk):**
   - Cấu hình `android:lockTaskMode="normal"` và kích hoạt `startLockTask()` / `stopLockTask()` an toàn trong `RobotNativePlugin.java`.
   - Có sẵn nút **Bật Ghim Ứng Dụng**, **Kiểm tra trạng thái ghim** và **Gỡ Ghim Thoát App** ngay trong tab Cài đặt.
4. **Sửa lỗi Chế độ Học Tiếng Anh & Tự động qua câu tiếp theo:**
   - Gỡ bỏ `getUserMedia` gây tranh chấp Micro với `SpeechRecognizer` và thêm `listenSessionId` chống nhiễu phiên nghe.
   - Ưu tiên chấm điểm phát âm tiếng Anh (`en-US`) khi Bảng luyện đọc đang mở, tự động thưởng `+1 ★` và chuyển sang câu tiếp theo khi đạt từ `75%` trở lên.

## Mã bảo mật mặc định (Có thể đổi trong Cài đặt)
- **Mở khóa Cài đặt (`⚙️`):** `202799`, `robotrobot` hoặc PIN Phụ huynh `1234`
- **Mã Nhà phát triển (gỡ ghim Kiosk thoát về điện thoại):** `DEV2027PRO` (hoặc `202799`)
