# Hướng dẫn đưa app lên Vercel

App đã được sửa để chạy được trên Vercel: dữ liệu (tài khoản, tiến độ học)
giờ lưu trong **Postgres** thay vì file `db.json`, vì Vercel không giữ file
lâu dài giữa các lần chạy.

## Bước 1 — Tạo database Postgres miễn phí

Dùng **Neon** (dễ nhất, có gói free, tích hợp sẵn với Vercel):

1. Vào https://neon.tech → đăng ký (có thể dùng tài khoản GitHub/Google).
2. Tạo 1 project mới.
3. Vào phần **Connection string**, copy chuỗi dạng:
   `postgresql://user:password@ep-xxxx.aws.neon.tech/neondb?sslmode=require`
4. Giữ lại chuỗi này, sẽ dùng ở Bước 3.

(Có thể dùng Supabase hoặc Vercel Postgres/Storage tương tự — chỉ cần có
được 1 chuỗi kết nối Postgres.)

## Bước 2 — Đưa code lên GitHub

1. Tạo 1 repo mới trên GitHub.
2. Đẩy toàn bộ nội dung thư mục này lên repo đó (`git init`, `git add .`,
   `git commit`, `git push`).

## Bước 3 — Deploy trên Vercel

1. Vào https://vercel.com → đăng nhập → **Add New → Project**.
2. Chọn repo GitHub vừa tạo → Import.
3. Ở phần **Environment Variables**, thêm:
   - `DATABASE_URL` = chuỗi kết nối Postgres ở Bước 1
  - `GEMINI_API_KEY` = API key Google Gemini (lấy miễn phí tại
    https://aistudio.google.com/apikey) — cần cho tính năng luyện dịch AI
  - `CRON_SECRET` = 1 chuỗi bí mật tự đặt (vd 1 chuỗi random dài) — dùng để
    khoá endpoint sinh dữ liệu AI, tránh người lạ gọi tràn tốn tiền/quota
    Gemini của bạn. Không bắt buộc nhưng rất khuyến khích.
4. Bấm **Deploy**. Đợi khoảng 1 phút.
5. Xong! Vercel cho bạn 1 link dạng `https://ten-app.vercel.app` — vào link
   đó dùng app bình thường.

## Bước 4 — Cho AI tự sinh dữ liệu (Hán Việt / chiết tự / ví dụ) chạy NHIỀU LẦN/NGÀY

Vercel Hobby (miễn phí) chỉ cho phép cron dựng sẵn (`vercel.json`) chạy
**tối đa 1 lần/ngày** — file này đã đặt sẵn ở mức tối đa đó (21h UTC mỗi
ngày), không thể tăng thêm nếu không nâng cấp lên Vercel Pro.

Để tự động chạy **nhiều lần hơn mỗi ngày mà vẫn miễn phí**, project đã có
sẵn 1 workflow GitHub Actions ở `.github/workflows/generate-daily.yml`,
gọi thẳng vào cùng API đó mỗi 15 phút (điều chỉnh được). Cách bật:

1. Vào repo GitHub của project → **Settings → Secrets and variables →
   Actions**.
2. Thêm secret `APP_URL` = link app đã deploy (vd
   `https://ten-app.vercel.app`, không có dấu `/` cuối).
3. Nếu Bước 3 bạn có đặt `CRON_SECRET` trên Vercel, thêm thêm 1 secret
   `CRON_SECRET` với **đúng giá trị đó**.
4. Vào tab **Actions** của repo, bật workflow lên nếu GitHub hỏi.

Xong — từ giờ mỗi 15 phút GitHub sẽ tự gọi 1 lần để sinh thêm dữ liệu, cho
tới khi phủ hết toàn bộ từ vựng thì các lượt gọi sau gần như không tốn gì
(trả lời ngay vì không còn gì để sinh thêm). Muốn đổi tần suất, sửa dòng
`cron:` trong file workflow (vd `*/30 * * * *` = 30 phút/lần).

## Lưu ý

- Tài khoản **đăng ký đầu tiên** trên app sẽ tự động là `superadmin`.
- Nếu quên set `DATABASE_URL`, app sẽ báo lỗi "Chưa cấu hình biến môi
  trường DATABASE_URL" khi gọi API — vào **Project Settings → Environment
  Variables** trên Vercel để thêm/sửa, sau đó **Redeploy**.
- Muốn chạy thử ở máy local trước khi deploy:
  ```
  npm install
  DATABASE_URL="chuỗi-kết-nối-của-bạn" GEMINI_API_KEY="key-của-bạn" npm start
  ```
  rồi mở `http://localhost:3000`.
