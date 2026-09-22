import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema.sqlite.ts';

// Daftar bukti wajib (template tugas). Satu sumber untuk seed + migrasi.
export const BUKTI_TEMPLATE = [
  'Foto saat melaksanakan piket',
  'Foto kondisi mako sebelum piket / awal datang',
  'Foto kondisi mako setelah piket / serah terima',
  'Foto serah terima piket',
];

const dbFile = process.env.DB_FILE ?? './dev.db';

const sqlite = new Database(dbFile);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// DDL inline (tanpa file migrasi) — cukup untuk dev lokal.
// Saat pindah ke Supabase: drizzle-kit migrate dengan db/schema.pg.ts.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, nama TEXT NOT NULL, warna TEXT NOT NULL,
  divisi TEXT NOT NULL DEFAULT 'acara', foto TEXT, angkatan TEXT, jabatan TEXT,
  last_seen INTEGER, pin_hash TEXT
);
CREATE TABLE IF NOT EXISTS roster (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  jam_mulai TEXT NOT NULL DEFAULT '09.00', jam_selesai TEXT NOT NULL DEFAULT '15.00'
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT NOT NULL,
  judul TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS swaps (
  id TEXT PRIMARY KEY, requester TEXT NOT NULL REFERENCES members(id),
  target TEXT NOT NULL REFERENCES members(id),
  from_day TEXT NOT NULL, to_day TEXT NOT NULL,
  alasan TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT NOT NULL,
  tugas TEXT NOT NULL DEFAULT '',
  member_id TEXT NOT NULL REFERENCES members(id),
  file TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_tanggal ON evidence(tanggal);
CREATE TABLE IF NOT EXISTS faces (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  descriptors TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  jam TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_tanggal ON attendance(tanggal);
CREATE TABLE IF NOT EXISTS lapsit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  catatan TEXT NOT NULL, lat TEXT, lng TEXT, acc INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lapsit_tanggal ON lapsit(tanggal);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  sub TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tugas_master (
  no INTEGER PRIMARY KEY, kategori TEXT NOT NULL, judul TEXT NOT NULL UNIQUE,
  bobot INTEGER NOT NULL, jenis TEXT NOT NULL, foto_wajib INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'draft', nilai REAL,
  submitted_at INTEGER, verified_by TEXT, verified_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assess_uniq ON assessments(tanggal, member_id);
CREATE TABLE IF NOT EXISTS assessment_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id),
  no INTEGER NOT NULL, kategori TEXT NOT NULL, judul TEXT NOT NULL,
  bobot INTEGER NOT NULL, jenis TEXT NOT NULL,
  foto_wajib INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'tidak', done_by TEXT,
  CONSTRAINT chk_item_na CHECK (jenis='Kondisional' OR status != 'na')
);
CREATE TABLE IF NOT EXISTS item_koreksi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES assessment_items(id),
  status_lama TEXT NOT NULL, status_baru TEXT NOT NULL,
  catatan TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kehadiran (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'hadir', acc TEXT, by TEXT, at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hadir_uniq ON kehadiran(tanggal, member_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`);

// Migrasi DB lama (evidence per-anggota selfie/tugas) → per-tugas. Dev-only.
try {
  const cols = sqlite.prepare('PRAGMA table_info(evidence)').all() as { name: string }[];
  const names = cols.map((c) => c.name);
  if (names.includes('jenis')) {
    sqlite.exec(`ALTER TABLE evidence RENAME TO evidence_old;
      CREATE TABLE evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT NOT NULL,
        tugas TEXT NOT NULL DEFAULT '',
        member_id TEXT NOT NULL REFERENCES members(id),
        file TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      DROP TABLE evidence_old;
      CREATE INDEX IF NOT EXISTS idx_evidence_tanggal ON evidence(tanggal);`);
    const up = process.env.UPLOAD_DIR ?? './uploads';
    for (const f of fs.readdirSync(up)) {
      if (/_selfie\.jpg$/.test(f) || /_tugas\.jpg$/.test(f)) {
        try { fs.unlinkSync(path.join(up, f)); } catch { /* abaikan */ }
      }
    }
    console.log('migrasi evidence → per-tugas ok');
  }
  const mcols = sqlite.prepare('PRAGMA table_info(members)').all() as { name: string }[];
  if (!mcols.some((c) => c.name === 'jabatan')) {
    sqlite.exec('ALTER TABLE members ADD COLUMN jabatan TEXT');
    console.log('migrasi members +jabatan ok');
  }
  if (!mcols.some((c) => c.name === 'last_seen')) {
    sqlite.exec('ALTER TABLE members ADD COLUMN last_seen INTEGER');
    console.log('migrasi members +last_seen ok');
  }
  if (!mcols.some((c) => c.name === 'pin_hash')) {
    sqlite.exec('ALTER TABLE members ADD COLUMN pin_hash TEXT');
    sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pin_unique ON members(pin_hash)');
    console.log('migrasi members +pin_hash ok');
  }
} catch { /* DB fresh, lewati */ }

export const db: BetterSQLite3Database<typeof schema> = drizzle(sqlite, { schema });

// Reset template ke daftar bukti wajib bila masih template lama. Dev-only.
try {
  const tplTitles = (sqlite.prepare("SELECT judul FROM tasks WHERE tanggal='template'").all() as { judul: string }[])
    .map((r) => r.judul);
  const same = tplTitles.length === BUKTI_TEMPLATE.length
    && BUKTI_TEMPLATE.every((t) => tplTitles.includes(t));
  if (!same) {
    sqlite.exec('DELETE FROM tasks; DELETE FROM evidence;');
    BUKTI_TEMPLATE.forEach((judul, i) => {
      db.insert(schema.tasks).values({ tanggal: 'template', judul, done: 0, sort: i }).run();
    });
    const up = process.env.UPLOAD_DIR ?? './uploads';
    for (const f of fs.readdirSync(up)) {
      if (/\.jpg$/.test(f)) {
        try { fs.unlinkSync(path.join(up, f)); } catch { /* abaikan */ }
      }
    }
    console.log('reset template → bukti piket (4 item) ok');
  }
} catch { /* abaikan */ }
