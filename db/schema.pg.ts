// Skema PostgreSQL/Supabase — dipakai SETELAH local dev 100% selesai.
// Tabel & kolom identik dengan db/schema.sqlite.ts; hanya tipe dialect yang beda.
// Migrasi: drizzle-kit generate --config=drizzle.pg.config.ts lalu migrate ke Supabase.
// Kode server & frontend tidak perlu berubah selain ganti import schema + client.
import { check, integer, pgTable, real, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const members = pgTable('members', {
  id: text('id').primaryKey(),
  nama: text('nama').notNull(),
  warna: text('warna').notNull(),
  divisi: text('divisi').notNull().default('acara'),
  foto: text('foto'),
  angkatan: text('angkatan'),
  jabatan: text('jabatan'),
  lastSeen: integer('last_seen'),
  pinHash: text('pin_hash'),
});

export const roster = pgTable('roster', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  day: text('day').notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  jamMulai: text('jam_mulai').notNull().default('09.00'),
  jamSelesai: text('jam_selesai').notNull().default('15.00'),
  weekStart: text('week_start'), // NULL = template berulang; else override minggu ybs
});

export const tasks = pgTable('tasks', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  tanggal: text('tanggal').notNull(),
  memberId: text('member_id').references(() => members.id), // NULL = baris template
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

// Rincian Tugas (Opsional) — checklist 34 item, PER ORANG (lihat schema.sqlite.ts).
export const breakdown = pgTable('breakdown', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  tanggal: text('tanggal').notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  itemKey: text('item_key').notNull(),
  doneAt: integer('done_at').notNull(),
});

export const pushSubs = pgTable('push_subs', {
  endpoint: text('endpoint').primaryKey(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  sub: text('sub').notNull(),
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

export const tugasMaster = pgTable('tugas_master', {
  no: integer('no').primaryKey(),
  kategori: text('kategori').notNull(),
  judul: text('judul').notNull().unique(),
  bobot: integer('bobot').notNull(),
  jenis: text('jenis').notNull(),
  fotoWajib: integer('foto_wajib').notNull().default(0),
});

export const assessments = pgTable('assessments', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  tanggal: text('tanggal').notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  status: text('status').notNull().default('draft'),
  nilai: real('nilai'),
  submittedAt: integer('submitted_at'),
  verifiedBy: text('verified_by'),
  verifiedAt: integer('verified_at'),
});

export const assessmentItems = pgTable(
  'assessment_items',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    assessmentId: integer('assessment_id')
      .notNull()
      .references(() => assessments.id),
    no: integer('no').notNull(),
    kategori: text('kategori').notNull(),
    judul: text('judul').notNull(),
    bobot: integer('bobot').notNull(),
    jenis: text('jenis').notNull(),
    fotoWajib: integer('foto_wajib').notNull().default(0),
    status: text('status').notNull().default('tidak'),
    doneBy: text('done_by'),
  },
  (t) => [
    check(
      'chk_item_na',
      sql`${t.jenis} = 'Kondisional' OR ${t.status} != 'na'`,
    ),
  ],
);

export const itemKoreksi = pgTable('item_koreksi', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  itemId: integer('item_id')
    .notNull()
    .references(() => assessmentItems.id),
  statusLama: text('status_lama').notNull(),
  statusBaru: text('status_baru').notNull(),
  catatan: text('catatan').notNull(),
  by: text('by').notNull(),
  at: integer('at').notNull(),
});

export const kehadiran = pgTable('kehadiran', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  tanggal: text('tanggal').notNull(),
  memberId: text('member_id')
    .notNull()
    .references(() => members.id),
  status: text('status').notNull().default('hadir'),
  acc: text('acc'),
  by: text('by'),
  at: integer('at').notNull(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
