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
});

export const roster = sqliteTable('roster', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  day: text('day').notNull(), // Senin..Jumat
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  jamMulai: text('jam_mulai').notNull().default('09.00'),
  jamSelesai: text('jam_selesai').notNull().default('15.00'),
});

// Checklist per tanggal. Baris bertanggal 'template' = master tugas harian,
// di-clone ke tanggal nyata saat pertama dibaca.
export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tanggal: text('tanggal').notNull(), // YYYY-MM-DD atau 'template'
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

// Bukti per tugas: 1 foto per judul tugas per tanggal (shared, siapa pun boleh upload).
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

// Wajah terdaftar: 1 baris per anggota, descriptors = JSON number[][] (maks 3).
// Cocok di HP via face-api.js lokal — biometrik tidak keluar perangkat selain vektor ini.
export const faces = sqliteTable('faces', {
  memberId: text('member_id')
    .primaryKey()
    .references(() => members.id),
  descriptors: text('descriptors').notNull(),
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
