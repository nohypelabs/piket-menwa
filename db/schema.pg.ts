// Skema PostgreSQL/Supabase — dipakai SETELAH local dev 100% selesai.
// Tabel & kolom identik dengan db/schema.sqlite.ts; hanya tipe dialect yang beda.
// Migrasi: drizzle-kit generate --config=drizzle.pg.config.ts lalu migrate ke Supabase.
// Kode server & frontend tidak perlu berubah selain ganti import schema + client.
import { integer, pgTable, text } from 'drizzle-orm/pg-core';

export const members = pgTable('members', {
  id: text('id').primaryKey(),
  nama: text('nama').notNull(),
  warna: text('warna').notNull(),
  divisi: text('divisi').notNull().default('acara'),
  foto: text('foto'),
  angkatan: text('angkatan'),
  jabatan: text('jabatan'),
  lastSeen: integer('last_seen'),
});

export const roster = pgTable('roster', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  day: text('day').notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  jamMulai: text('jam_mulai').notNull().default('09.00'),
  jamSelesai: text('jam_selesai').notNull().default('15.00'),
});

export const tasks = pgTable('tasks', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  tanggal: text('tanggal').notNull(),
  judul: text('judul').notNull(),
  done: integer('done').notNull().default(0),
  sort: integer('sort').notNull().default(0),
});

export const swaps = pgTable('swaps', {
  id: text('id').primaryKey(),
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

// Bukti piket — nanti file pindah ke Supabase Storage, kolom file = public URL.
// Bukti per tugas — nanti file pindah ke Supabase Storage, kolom file = public URL.
export const evidence = pgTable('evidence', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  tanggal: text('tanggal').notNull(),
  tugas: text('tugas').notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  file: text('file').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const lapsit = pgTable('lapsit', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
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

export const faces = pgTable('faces', {
  memberId: text('member_id')
    .primaryKey()
    .references(() => members.id),
  descriptors: text('descriptors').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const attendance = pgTable('attendance', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  tanggal: text('tanggal').notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  jam: text('jam').notNull(),
  createdAt: integer('created_at').notNull(),
});
