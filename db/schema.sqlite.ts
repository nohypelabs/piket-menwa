// Skema SQLite (dev lokal). Kolom & tipe dibuat portabel agar 1:1 bisa
// dimigrasi ke PostgreSQL/Supabase — lihat db/schema.pg.ts untuk padanannya.
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const members = sqliteTable('members', {
  id: text('id').primaryKey(),
  nama: text('nama').notNull(),
  warna: text('warna').notNull(),
  divisi: text('divisi').notNull().default('acara'),
  foto: text('foto'), // path foto referensi saat daftar (uploads/faces/..)
  angkatan: text('angkatan'), // tahun menwa, misal 2023
  jabatan: text('jabatan'), // jabatan di kompi
  lastSeen: integer('last_seen'), // heartbeat presence (epoch ms)
  pinHash: text('pin_hash'), // SHA-256 PIN login (unik)
  noFaceConsent: integer('no_face_consent').notNull().default(0), // 1 = menolak scan wajah saat daftar (PIN-only, absen diinput manual admin)
});

export const roster = sqliteTable('roster', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  day: text('day').notNull(), // Senin..Jumat
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  jamMulai: text('jam_mulai').notNull().default('09.00'),
  jamSelesai: text('jam_selesai').notNull().default('15.00'),
  // Senin dari minggu ybs (YYYY-MM-DD), NULL = default/template berulang.
  // Ada baris dgn weekStart tertentu → override KHUSUS minggu itu (dipakai
  // drag-drop di tab Mingguan: geser jadwal minggu depan/seterusnya tanpa
  // mengubah template dasar).
  weekStart: text('week_start'),
});

// Checklist per tanggal PER ORANG. Baris bertanggal 'template' (memberId
// NULL) = master tugas harian, di-clone per anggota piket saat pertama kali
// checklist tanggal itu dibaca oleh member tsb (bukan shared 1 baris untuk
// semua orang yang piket hari itu).
export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tanggal: text('tanggal').notNull(), // YYYY-MM-DD atau 'template'
  memberId: text('member_id').references(() => members.id), // NULL = baris template
  judul: text('judul').notNull(),
  done: integer('done').notNull().default(0),
  sort: integer('sort').notNull().default(0),
});

export const swaps = sqliteTable('swaps', {  id: text('id').primaryKey(),
  requester: text('requester')
    .notNull()
    .references(() => members.id),
  target: text('target')
    .notNull()
    .references(() => members.id),
  fromDay: text('from_day').notNull(),
  toDay: text('to_day').notNull(),
  alasan: text('alasan').notNull().default(''),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
});

// Bukti per tugas PER ORANG: tiap anggota yang piket upload fotonya
// SENDIRI-SENDIRI (bukan shared 1 foto untuk semua yang piket hari itu).
// Unique effektif per (tanggal, tugas, memberId) — divalidasi di server.
// File di disk ./uploads (nanti: Supabase Storage), kolom file = path/URL.
export const evidence = sqliteTable('evidence', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tanggal: text('tanggal').notNull(), // YYYY-MM-DD
  tugas: text('tugas').notNull(), // judul tugas, harus cocok tasks
  memberId: text('member_id')
    .notNull()
    .references(() => members.id), // pengupload
  file: text('file').notNull(),
  createdAt: integer('created_at').notNull(),
});

// Lapsit akhir piket: catatan + stempel waktu server + koordinat HP.
export const lapsit = sqliteTable('lapsit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tanggal: text('tanggal').notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  catatan: text('catatan').notNull(),
  lat: text('lat'),
  lng: text('lng'),
  acc: integer('acc'),
  createdAt: integer('created_at').notNull(),
});

// Rincian Tugas (Opsional) — checklist 34 item dari BREAKDOWN (src/breakdown.ts),
// PER ORANG. Dulu cuma tersimpan di localStorage HP (server tidak pernah
// tahu), jadi tidak pernah ikut ke perhitungan nilai. Sekarang disinkron ke
// server: 1 baris per item yang SUDAH dicentang (key = "groupIndex:itemIndex").
export const breakdown = sqliteTable(
  'breakdown',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tanggal: text('tanggal').notNull(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id),
    itemKey: text('item_key').notNull(), // "gi:ii"
    doneAt: integer('done_at').notNull(),
  },
);

// Langganan push per perangkat (1 anggota boleh banyak device).
export const pushSubs = sqliteTable('push_subs', {
  endpoint: text('endpoint').primaryKey(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  sub: text('sub').notNull(), // JSON subscription
  createdAt: integer('created_at').notNull(),
});
// Bukti match wajah hari ini: dasar token atestasi (1 hari, multi-pakai).
export const attestIssued = sqliteTable('attest_issued', {
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  tanggal: text('tanggal').notNull(),
  at: integer('at').notNull(),
});

// Wajah terdaftar: 1 baris per anggota, descriptors = CIPHERTEXT (AES-256-GCM,
// lihat db/crypto.ts) dari JSON number[][] (maks 3 vektor 128-dim). Tidak ada
// foto wajah di sini — cuma embedding terenkripsi, matching dilakukan di
// server (client tidak pernah menerima descriptor mentah siapa pun).
export const faces = sqliteTable('faces', {
  memberId: text('member_id')
    .primaryKey()
    .references(() => members.id),
  descriptors: text('descriptors').notNull(), // ciphertext base64
  updatedAt: integer('updated_at').notNull(),
});

// Absen tiba per tanggal (dicatat saat verifikasi wajah lolos).
export const attendance = sqliteTable('attendance', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tanggal: text('tanggal').notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  jam: text('jam').notNull(), // HH.MM
  createdAt: integer('created_at').notNull(),
  // Selfie absen (HANYA untuk member noFaceConsent=1, pengganti face-match).
  // Ciphertext AES-256-GCM (foto sudah di-watermark nama+jam+logo di client
  // SEBELUM dienkripsi) — dipakai sebagai bukti rekap, BUKAN utk matching
  // algoritma apa pun. Hanya admin/superadmin yang bisa minta didekripsi.
  selfieEnc: text('selfie_enc'),
});

// ---- Penilaian otomatis: master bobot tugas (dipakai validasi foto + seed) ----
export const tugasMaster = sqliteTable('tugas_master', {
  no: integer('no').primaryKey(),
  kategori: text('kategori').notNull(),
  judul: text('judul').notNull().unique(),
  bobot: integer('bobot').notNull(),
  jenis: text('jenis').notNull(), // Wajib | Kondisional
  fotoWajib: integer('foto_wajib').notNull().default(0),
});

// Settings: ketua_id, wakil_id (diatur superadmin).
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
