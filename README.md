# Screenshot API

API สำหรับแปลงหน้าเว็บเป็นภาพ (screenshot) ด้วย Express + Puppeteer

## Features
- รองรับ HTTP/HTTPS
- ประสิทธิภาพสูง (auto-sleep browser instance)
- พร้อม deploy บน Render หรือใช้งาน local

## วิธีใช้งาน

### 1. ติดตั้ง Dependencies
- ติดตั้ง [bun](https://bun.sh/docs/installation) (หรือใช้ npm ก็ได้)
- ติดตั้ง dependencies:
  ```bash
  bun install
  # หรือ
  npm install
  ```

### 2. สร้าง SSL สำหรับ HTTPS (ถ้าต้องการ)
```bash
openssl req -nodes -new -x509 -keyout key.pem -out cert.pem
```

### 3. รัน Server
```bash
bun start
# หรือ
bun index.js
```

### 4. เรียกใช้งาน API
- GET `/screenshot?url=https://example.com` : ได้ภาพ PNG ของหน้าเว็บ

### 5. Deploy บน Render
- ใช้ไฟล์ `render.yaml` ที่เตรียมไว้
- เชื่อมต่อกับ Git และ Render จะ deploy อัตโนมัติ

## ตัวอย่าง Request
```bash
curl "http://localhost:3000/screenshot?url=https://www.google.com" --output google.png
```

## .gitignore
- ไม่อัพไฟล์ `node_modules/`, `package-lock.json`, `.env` ขึ้น Git

## หมายเหตุ
- สำหรับ production ควรใช้ SSL ที่ออกโดย CA จริง
- สามารถปรับ config ใน `.env` ได้ตามต้องการ

---

Powered by Express, Puppeteer, Bun
