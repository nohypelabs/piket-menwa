# 📋 Piket PWA — Shift Scheduling + Face Attendance + Auto Scoring

Progressive Web App untuk **jadwal piket, absensi wajah, bukti foto ber-stempel, lapsit, tukar jadwal, dan penilaian otomatis**. Dibangun generik: bisa dipakai organisasi apa pun — komunitas kampus, karang taruna, sekre organisasi, tim jaga — bukan cuma satu instansi.

> Frontend PWA (installable, offline-ready, TWA-ready untuk jadi `.apk` Play Store) + backend Express + SQLite via Drizzle (siap migrasi ke Supabase Postgres).

---

## ✨ Fitur

### 🔐 Auth & Identitas
- **Login wajah** — tahan tombol fingerprint 1 detik → face recognition otomatis (anti-spoof: sampel wajib frontal + stabil, threshold + margin).
- **Login PIN** — tahan 2 detik → form PIN 6 digit (aturan: bukan angka kembar/urutan/tahun angkatan, unik per orang).
- **Registrasi mandiri** — wizard 4 langkah (Nama → Angkatan → Jabatan → PIN) + scan wajah 3 tahap terpandu (tahan–kanan–kiri) + tolak duplikat wajah & nama+angkatan ganda.
- **Sesi harian** — login & verifikasi berlaku 1 hari; tiap hari wajib verifikasi wajah ulang.

### 🧑‍💼 Piket Harian
- **Absensi wajah wajib** — hanya face recognition (tidak ada jalur PIN), tercatat jam + kehadiran.
- **Bukti foto wajib (4 item)** — otomatis terkompres **WebP ≤ 40KB** di HP, dibakar stempel **tanggal + jam + koordinat + logo organisasi**, immutable (tidak bisa ubah/hapus).
- **Lapsit akhir piket** — catatan + timestamp server + geolocation, terkunci sampai 4 foto lengkap.
- **Rincian 34 tugas** (5 kategori akordeon) — checklist per shift, tersimpan di server.
- **Presence online** — heartbeat tiap 30 detik, titik hijau kayak aplikasi chat.

### 🔄 Tukar Jadwal
- Pengajuan → yang **diminta** yang menyetujui (bukan admin). Pemohon bisa batalkan. Admin hanya override.
- Notifikasi push (VAPID) + in-app untuk pengajuan/keputusan baru.

### 🏆 Penilaian Otomatis (real-time, tanpa verifikasi manual)
- **60%** foto bukti • **30%** checklist 34 item • **10%** lapsit → nilai 0–100 + **leaderboard** (khusus superadmin, anggota tidak melihat nilai).
- Master 34 tugas + bobot (total 100) di-seed dari standar; N/A hanya untuk item Kondisional (dikunci di UI + API + CHECK constraint DB).

### 🛡️ Peran
| Peran | Akses |
|---|---|
| Anggota | Jadwal, absen, bukti, lapsit, tukar, rincian tugas |
| Admin (PIN) | Susun roster + jam, drag-and-drop mingguan, override tukar, putar rotasi |
| Superadmin (PIN + `#super`) | Dashboard monitoring: pengguna, rekap harian, foto, lapsit, log aktivitas, leaderboard, hapus data |

### 🔒 Privasi Face Recognition
- Embedding wajah **dienkripsi AES-256-GCM** at-rest; matching **hanya di server** — client tidak pernah menerima vektor wajah orang lain.
- Model AI (face-api) di-bundle lokal → jalan offline setelah dibuka sekali.

---

## 🧰 Tech Stack

| Lapis | Teknologi |
|---|---|
| Frontend | React 19 + Vite 8 + TypeScript, framer-motion, lucide-react, zod |
| PWA | `vite-plugin-pwa` (injectManifest, SW custom `src/sw.ts`: precache + cache foto + web push) |
| Face AI | face-api.js + model lokal (`public/models`, `public/libs`) |
| Backend | Express 5 (REST JSON), `web-push` (VAPID) |
| Database | SQLite (`better-sqlite3`) via Drizzle ORM — skema Postgres 1:1 di `db/schema.pg.ts` |
| Styling | CSS custom, tema Tactical HUD |

---

## 🚀 Quickstart

```bash
pnpm install

# 1. Isi .env (lihat tabel di bawah) — minimal FACE_ENC_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 2. Seed data awal (template bukti + 34 master tugas)
pnpm seed

# 3. Jalan bareng (API :3001 + web :5173)
pnpm dev:all
```

Buka `http://localhost:5173` (kamera butuh HTTPS di HP — pakai tunnel, mis. `cloudflared tunnel --url http://localhost:5173`).

### ⚙️ Environment (`.env`)

| Key | Wajib | Keterangan |
|---|---|---|
| `FACE_ENC_KEY` | Ya | base64 32 byte — enkripsi embedding wajah (jangan masuk git!) |
| `ADMIN_PIN` | — | Default `1234` — mode Admin |
| `SUPER_PIN` | — | Default `041294` — dashboard `#super` |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` | — | Auto-generate ke `server/.vapid.json` bila kosong |
| `PORT` / `DB_FILE` / `UPLOAD_DIR` | — | Default `3001` / `./dev.db` / `./uploads` |

### 🔌 API (ringkas)

Autentikasi aksi sensitif: identitas member dari sesi login; admin pakai header `x-admin-pin`, superadmin `x-super-pin`.

| Area | Endpoint |
|---|---|
| State | `GET /api/state` |
| Register/Login | `POST /api/register`, `POST /api/login/pin`, `POST /api/pin/set` |
| Wajah | `POST /api/faces/match` (server-side), `GET /api/faces/summary` (admin) |
| Absen/Hadir | `POST /api/attendance`, `GET /api/attendance`, `POST /api/kehadiran/*` |
| Bukti/Lapsit | `POST /api/evidence`, `GET /api/evidence` (signed URL), `POST /api/lapsit` |
| Rincian | `GET/POST /api/breakdown`, `GET /api/checks` |
| Tukar | `POST /api/swaps`, `POST /api/swaps/:id/decide`, `POST /api/swaps/:id/cancel` |
| Roster | `PUT /api/roster`, `GET/PUT/DELETE /api/roster/week` (admin) |
| Nilai | `GET /api/nilai/today`, `GET /api/nilai/leaderboard`, `GET /api/nilai/master` |
| Push/Presence | `GET /api/push/public-key`, `POST /api/push/subscribe`, `POST /api/presence` |
| Super | `POST /api/super/verify`, `GET /api/super/overview`, `GET /api/super/feed` |

---

## 📁 Struktur Project

```
├── src/                # React app — App.tsx cuma composition root (DevWay)
│   ├── hooks/useAppStore.ts  # seluruh state + handler (satu store eksplisit)
│   ├── tabs/           # HariTab, MingguanTab, TukarTab (presentasional)
│   ├── components/     # Toast, FaceCam, WeekDragBoard, BottomTabs,
│   │                   # PinSheet, LogoutSheet, PhotoPreview, ConfirmIdentity…
│   ├── face.ts         # loader model + geometri yaw + audio ting
│   ├── bukti.ts        # kompres WebP ≤40KB + stempel watermark + geo
│   ├── api.ts          # client API + fallback offline (localStorage)
│   └── sw.ts           # service worker: precache, cache foto, push handler
```

### 🎨 Ganti Brand Organisasi Lain
1. Timpa `public/brand/logo-menwa.png` dengan logo sendiri.
2. `python3 scripts/gen-icons.py` → ikon home-screen, splash, favicon ke-regenerate.
3. Sesuaikan nama di `index.html` + `vite.config.ts` (manifest) + roster/bobot di seed.

---

## 📦 Deploy

- **Frontend** → Vercel / static hosting (HTTPS wajib untuk kamera + push).
- **Jadi APK (TWA)** — PWA ini TWA-ready: `manifest.webmanifest` + icons + service worker. Bungkus pakai Bubblewrap → `.aab` → Play Store ($25 sekali bayar), jangan lupa `assetlinks.json`.
- **Backend** → VPS / Railway / Fly (butuh filesystem persisten untuk SQLite+upload), atau migrasi ke Supabase lalu jadikan serverless functions.
- **Migrasi Supabase** — skema PG sudah mirror 1:1 (`db/schema.pg.ts`): generate via drizzle-kit → migrate → ganti import schema + Storage untuk file.

---

## 🗺️ Roadmap
- [ ] Migrasi Supabase (Postgres + Storage + Auth opsional)
- [ ] Push reminder H-1 otomatis (cron)
- [ ] Liveness detection anti-foto (blink challenge)
- [ ] Export rekap PDF/Excel untuk pembina
