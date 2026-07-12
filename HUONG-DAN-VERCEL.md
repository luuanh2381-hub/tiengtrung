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
4. Bấm **Deploy**. Đợi khoảng 1 phút.
5. Xong! Vercel cho bạn 1 link dạng `https://ten-app.vercel.app` — vào link
   đó dùng app bình thường.

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
