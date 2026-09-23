// Skema SQLite (dev lokal). Kolom & tipe dibuat portabel agar 1:1 bisa
// dimigrasi ke PostgreSQL/Supabase — lihat db/schema.pg.ts untuk padanannya.
import { check, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

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
});

// ---- Penilaian piket per orang (hybrid: checklist per shift diganti per orang) ----
// Master tugas (bobot standar). Snapshot bobot disimpan per item assessment.
export const tugasMaster = sqliteTable('tugas_master', {
  no: integer('no').primaryKey(),
  kategori: text('kategori').notNull(),
  judul: text('judul').notNull().unique(),
  bobot: integer('bobot').notNull(),
  jenis: text('jenis').notNull(), // Wajib | Kondisional
  fotoWajib: integer('foto_wajib').notNull().default(0),
});

// Satu assessment = 1 anggota × 1 tanggal.
export const assessments = sqliteTable('assessments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tanggal: text('tanggal').notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  status: text('status').notNull().default('draft'), // draft | pending | verified
  nilai: real('nilai'),
  submittedAt: integer('submitted_at'),
  verifiedBy: text('verified_by'),
  verifiedAt: integer('verified_at'),
});

// 34 baris per assessment, bobot di-snapshot (revisi standar tidak mengubah nilai lama).
// LAPIS-2 enforcement: N/A hanya untuk Kondisional.
export const assessmentItems = sqliteTable(
  'assessment_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    assessmentId: integer('assessment_id')
      .notNull()
      .references(() => assessments.id),
    no: integer('no').notNull(),
    kategori: text('kategori').notNull(),
    judul: text('judul').notNull(),
    bobot: integer('bobot').notNull(),
    jenis: text('jenis').notNull(),
    fotoWajib: integer('foto_wajib').notNull().default(0),
    status: text('status').notNull().default('tidak'), // selesai | tidak | na
    doneBy: text('done_by'), // atribusi per orang per tugas (cadangan, nullable)
  },
  (t) => [
    check(
      'chk_item_na',
      sql`${t.jenis} = 'Kondisional' OR ${t.status} != 'na'`,
    ),
  ],
);

// Jejak audit koreksi ketua: nilai awal → koreksi, siapa, kapan, catatan wajib.
export const itemKoreksi = sqliteTable('item_koreksi', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  itemId: integer('item_id')
    .notNull()
    .references(() => assessmentItems.id),
  statusLama: text('status_lama').notNull(),
  statusBaru: text('status_baru').notNull(),
  catatan: text('catatan').notNull(),
  by: text('by').notNull(),
  at: integer('at').notNull(),
});

// Kehadiran per orang per tanggal. izin/sakit butuh acc ketua; alpa = 0 (aturan menyusul).
export const kehadiran = sqliteTable('kehadiran', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tanggal: text('tanggal').notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  status: text('status').notNull().default('hadir'), // hadir | izin | sakit | alpa
  acc: text('acc'), // null | pending | acc (untuk izin/sakit)
  by: text('by'),
  at: integer('at').notNull(),
});

// Settings: ketua_id, wakil_id (diatur superadmin).
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
