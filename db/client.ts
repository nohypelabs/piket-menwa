import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema.sqlite.ts';
import { encryptJson } from './crypto.ts';

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
  jam_mulai TEXT NOT NULL DEFAULT '09.00', jam_selesai TEXT NOT NULL DEFAULT '15.00',
  week_start TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT NOT NULL,
  member_id TEXT REFERENCES members(id),
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
CREATE TABLE IF NOT EXISTS attest_issued (
  member_id TEXT NOT NULL REFERENCES members(id),
  tanggal TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (member_id, tanggal)
);
CREATE TABLE IF NOT EXISTS faces (  member_id TEXT PRIMARY KEY REFERENCES members(id),
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
CREATE TABLE IF NOT EXISTS breakdown (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  item_key TEXT NOT NULL, done_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_breakdown_uniq ON breakdown(tanggal, member_id, item_key);
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
  if (!mcols.some((c) => c.name === 'no_face_consent')) {
    sqlite.exec("ALTER TABLE members ADD COLUMN no_face_consent INTEGER NOT NULL DEFAULT 0");
    console.log('migrasi members +no_face_consent ok');
  }
  const acols = sqlite.prepare('PRAGMA table_info(attendance)').all() as { name: string }[];
  if (!acols.some((c) => c.name === 'selfie_enc')) {
    sqlite.exec('ALTER TABLE attendance ADD COLUMN selfie_enc TEXT');
    console.log('migrasi attendance +selfie_enc ok');
  }
  const rcols = sqlite.prepare('PRAGMA table_info(roster)').all() as { name: string }[];
  if (!rcols.some((c) => c.name === 'week_start')) {
    sqlite.exec('ALTER TABLE roster ADD COLUMN week_start TEXT');
    console.log('migrasi roster +week_start ok');
  }
  // 1 override per (minggu, hari, anggota) — cegah duplikat drag-drop yang gagal di-clean.
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_week_uniq ON roster(week_start, day, member_id) WHERE week_start IS NOT NULL');

  // Migrasi checklist tugas & bukti foto: dari SHARED (1 status/foto per hari
  // untuk semua yang piket) → PER ORANG (tiap anggota checklist & upload foto
  // sendiri-sendiri; hanya admin/superadmin yang bisa lihat semua orang).
  const tcols = sqlite.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  if (!tcols.some((c) => c.name === 'member_id')) {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN member_id TEXT REFERENCES members(id)');
    // Baris tanggal-nyata lama (bukan 'template') adalah checklist SHARED —
    // tidak valid lagi di model per-orang (tidak jelas dulu diisi siapa),
    // dibuang; tanggal berjalan otomatis di-clone ulang per member saat dibuka.
    sqlite.exec("DELETE FROM tasks WHERE tanggal != 'template'");
    console.log('migrasi tasks +member_id (checklist per-orang) ok');
  }
  // 1 baris checklist per (tanggal, member, judul) untuk tanggal nyata (bukan template).
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_member_uniq ON tasks(tanggal, member_id, judul) WHERE tanggal != \'template\'');
  // 1 foto per (tanggal, tugas, member) — dulunya per (tanggal, tugas) saja (shared).
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_member_uniq ON evidence(tanggal, tugas, member_id)');

  // Privasi biometrik: foto wajah pendaftaran (uploads/faces/*.jpg) DIHAPUS —
  // sistem sekarang cuma simpan face EMBEDDING (vektor angka, dienkripsi),
  // tidak pernah gambar wajah asli. members.foto yang lama menunjuk ke foto
  // wajah itu, jadi dikosongkan sekali (member bisa upload foto profil baru
  // yang OPSIONAL & terpisah lewat PUT /api/members/:id/foto).
  const mcols2 = sqlite.prepare('PRAGMA table_info(members)').all() as { name: string }[];
  if (mcols2.length && !sqlite.prepare("SELECT value FROM settings WHERE key='migrated_no_face_photo'").get()) {
    sqlite.exec("UPDATE members SET foto = NULL WHERE foto LIKE '/uploads/faces/%'");
    try {
      const facesDir = path.join(process.env.UPLOAD_DIR ?? './uploads', 'faces');
      if (fs.existsSync(facesDir)) fs.rmSync(facesDir, { recursive: true, force: true });
    } catch { /* best effort */ }
    sqlite.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('migrated_no_face_photo', '1')");
    console.log('migrasi: foto wajah dihapus (sekarang embedding-only + terenkripsi) ok');
  }

  // Foto evidence lama disimpan di root uploads/ dengan field DB = URL penuh
  // ("/uploads/xxx.jpg"). Sekarang foto evidence WAJIB lewat signed URL dan
  // disimpan di uploads/evidence/, field DB cuma nama file relatif. Migrasi
  // pindahkan file lama + perbaiki field sekali saja.
  if (mcols2.length && !sqlite.prepare("SELECT value FROM settings WHERE key='migrated_evidence_paths'").get()) {
    const base = process.env.UPLOAD_DIR ?? './uploads';
    const evDir = path.join(base, 'evidence');
    fs.mkdirSync(evDir, { recursive: true });
    const oldRows = sqlite.prepare("SELECT id, file FROM evidence WHERE file LIKE '/uploads/%' AND file NOT LIKE '/uploads/evidence/%'").all() as { id: number; file: string }[];
    for (const r of oldRows) {
      const fname = r.file.replace(/^\/uploads\//, '');
      const oldPath = path.join(base, fname);
      const newPath = path.join(evDir, fname);
      try { if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath); } catch { /* best effort */ }
      sqlite.prepare('UPDATE evidence SET file = ? WHERE id = ?').run(fname, r.id);
    }
    sqlite.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('migrated_evidence_paths', '1')");
    console.log(`migrasi: ${oldRows.length} foto evidence dipindah ke uploads/evidence/ + field DB diperbaiki`);
  }

  // Embedding wajah lama (sebelum AES-256-GCM ditambahkan) masih plain JSON
  // number[][]. Migrasi sekali: enkripsi ulang tiap baris memakai FACE_ENC_KEY
  // saat ini. Kalau baris sudah ciphertext (decrypt gagal parse sbg JSON
  // number[][] valid... sebaliknya JSON.parse akan berhasil utk plain data),
  // dibiarkan — deteksi via try JSON.parse dulu sebelum re-encrypt.
  if (mcols2.length && !sqlite.prepare("SELECT value FROM settings WHERE key='migrated_face_encryption'").get()) {
    const rows = sqlite.prepare('SELECT member_id, descriptors FROM faces').all() as { member_id: string; descriptors: string }[];
    let n = 0;
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.descriptors);
        if (!Array.isArray(parsed)) continue; // bukan plain JSON, kemungkinan sudah ciphertext base64 — skip
        const enc = encryptJson(parsed);
        sqlite.prepare('UPDATE faces SET descriptors = ? WHERE member_id = ?').run(enc, r.member_id);
        n++;
      } catch { /* sudah ciphertext (base64, bukan JSON valid) — skip */ }
    }
    sqlite.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('migrated_face_encryption', '1')");
    console.log(`migrasi: ${n} embedding wajah lama dienkripsi ulang (AES-256-GCM)`);
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
