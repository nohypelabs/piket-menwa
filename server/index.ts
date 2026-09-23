import cors from 'cors';
import { and, eq, isNull } from 'drizzle-orm';
import express from 'express';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import webpush from 'web-push';
import { db } from '../db/client.ts';
import { attendance, evidence, faces, lapsit, members, pushSubs, roster, swaps, tasks } from '../db/schema.sqlite.ts';
import {
  assessments, assessmentItems, itemKoreksi, kehadiran, settings, tugasMaster,
} from '../db/schema.sqlite.ts';
import { NILAI_MASTER, hitungNilai } from '../db/nilai_master.ts';

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' })); // foto dikirim sebagai dataURL terkompresi

// File bukti: ./uploads (nanti: Supabase Storage). Tanpa login —
// identitas = pilihan "Saya" di HP, server hanya validasi hari piket.
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? './uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR)));

const DAYS = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'] as const;

// ---- role: user vs admin(ketua). Aksi admin wajib header x-admin-pin ----
const ADMIN_PIN = process.env.ADMIN_PIN ?? '1234';
if (!process.env.ADMIN_PIN) console.log('⚠️  ADMIN_PIN belum diset, pakai default "1234" — ganti via env.');

// ---- superadmin (dev): dashboard monitoring, PIN terpisah ----
const SUPER_PIN = process.env.SUPER_PIN ?? '041294';
if (!process.env.SUPER_PIN) console.log('⚠️  SUPER_PIN belum diset, pakai default "041294" — ganti via env.');
const requireSuper = (
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
) => {
  if (req.header('x-super-pin') !== SUPER_PIN) {
    return void res.status(403).json({ error: 'butuh PIN superadmin' });
  }
  next();
};

const todayLocal = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

app.post('/api/super/verify', (req, res) => {
  res.json({ ok: req.body?.pin === SUPER_PIN });
});

app.get('/api/super/overview', requireSuper, (_req, res) => {
  const today = todayLocal();
  const onlineCut = Date.now() - 90000;
  res.json({
    members: db.select().from(members).all().length,
    faces: db.select().from(faces).all().length,
    roster: db.select().from(roster).all().length,
    online: db.select().from(members).all().filter((m) => (m.lastSeen ?? 0) > onlineCut).length,
    attToday: db.select().from(attendance).where(eq(attendance.tanggal, today)).all().length,
    attTotal: db.select().from(attendance).all().length,
    evToday: db.select().from(evidence).where(eq(evidence.tanggal, today)).all().length,
    lapsitToday: db.select().from(lapsit).where(eq(lapsit.tanggal, today)).all().length,
    swapsPending: db.select().from(swaps).where(eq(swaps.status, 'pending')).all().length,
  });
});

app.get('/api/super/feed', requireSuper, (req, res) => {
  const lim = Math.min(Number(req.query.limit ?? 50), 200);
  const mname = (id: string) =>
    db.select().from(members).where(eq(members.id, id)).all()[0]?.nama ?? id;
  const items: { t: number; jenis: string; teks: string }[] = [];
  for (const a of db.select().from(attendance).all()) {
    items.push({ t: a.createdAt, jenis: 'absen', teks: `${mname(a.memberId)} absen ${a.tanggal} pkl ${a.jam}` });
  }
  for (const e of db.select().from(evidence).all()) {
    items.push({ t: e.createdAt, jenis: 'foto', teks: `${mname(e.memberId)} upload foto: ${e.tugas.slice(0, 45)} (${e.tanggal})` });
  }
  for (const l of db.select().from(lapsit).all()) {
    items.push({ t: l.createdAt, jenis: 'lapsit', teks: `${mname(l.memberId)} lapsit: ${l.catatan.slice(0, 70)}` });
  }
  for (const s of db.select().from(swaps).all()) {
    items.push({ t: s.createdAt, jenis: 'tukar', teks: `${mname(s.requester)} ⇄ ${mname(s.target)} (${s.fromDay}⇄${s.toDay}) • ${s.status}` });
  }
  items.sort((a, b) => b.t - a.t);
  res.json(items.slice(0, lim));
});const requireAdmin = (
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
) => {
  if (req.header('x-admin-pin') !== ADMIN_PIN) {
    return void res.status(403).json({ error: 'butuh PIN Admin' });
  }
  next();
};

app.post('/api/admin/verify', (req, res) => {
  res.json({ ok: req.body?.pin === ADMIN_PIN });
});

// ---- bootstrap: semua state dalam 1 call ----
app.get('/api/state', (_req, res) => {
  res.json({
    members: db.select().from(members).all(),
    roster: db.select().from(roster).all(),
    template: db.select().from(tasks).where(eq(tasks.tanggal, 'template')).all(),
    swaps: db.select().from(swaps).all().sort((a, b) => b.createdAt - a.createdAt),
  });
});

// ---- roster (admin ganti jadwal + jam) — template dasar berulang tiap minggu ----
app.put('/api/roster', requireAdmin, (req, res) => {
  const rows = req.body.roster as { day: string; memberId: string; jamMulai?: string; jamSelesai?: string }[];
  if (!Array.isArray(rows)) return void res.status(400).json({ error: 'roster harus array' });
  for (const r of rows) {
    if (!DAYS.includes(r.day as (typeof DAYS)[number])) return void res.status(400).json({ error: `hari invalid: ${r.day}` });
  }
  const ids = db.select({ id: members.id }).from(members).all().map((m) => m.id);
  for (const r of rows) {
    if (!ids.includes(r.memberId)) return void res.status(400).json({ error: `anggota tidak dikenal: ${r.memberId}` });
    for (const j of [r.jamMulai ?? '09.00', r.jamSelesai ?? '15.00']) {
      if (!/^\d{2}\.\d{2}$/.test(j)) return void res.status(400).json({ error: `jam invalid: ${j}` });
    }
  }
  db.transaction((tx) => {
    // Hanya hapus baris TEMPLATE (weekStart null) — override per-minggu tidak boleh ikut kehapus.
    tx.delete(roster).where(isNull(roster.weekStart)).run();
    for (const r of rows) {
      tx.insert(roster).values({
        day: r.day, memberId: r.memberId,
        jamMulai: r.jamMulai ?? '09.00', jamSelesai: r.jamSelesai ?? '15.00',
      }).run();
    }
  });
  res.json({ ok: true });
});

// ---- roster per-minggu (drag-drop tab Mingguan): override khusus 1 minggu ----
// Baca jadwal EFEKTIF minggu tsb: kalau minggu itu punya override tersimpan,
// pakai override; kalau tidak, fallback ke template dasar (weekStart null).
app.get('/api/roster/week', (req, res) => {
  const start = String(req.query.start ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return void res.status(400).json({ error: 'start=YYYY-MM-DD (Senin minggu ybs)' });
  const overrideRows = db.select().from(roster).where(eq(roster.weekStart, start)).all();
  const rows = overrideRows.length > 0
    ? overrideRows
    : db.select().from(roster).where(isNull(roster.weekStart)).all();
  res.json({ roster: rows, overridden: overrideRows.length > 0 });
});

// Simpan hasil drag-drop untuk 1 minggu spesifik (tidak menyentuh template dasar
// ataupun override minggu lain).
app.put('/api/roster/week', requireAdmin, (req, res) => {
  const start = String(req.body.start ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return void res.status(400).json({ error: 'start=YYYY-MM-DD (Senin minggu ybs)' });
  const rows = req.body.roster as { day: string; memberId: string; jamMulai?: string; jamSelesai?: string }[];
  if (!Array.isArray(rows)) return void res.status(400).json({ error: 'roster harus array' });
  for (const r of rows) {
    if (!DAYS.includes(r.day as (typeof DAYS)[number])) return void res.status(400).json({ error: `hari invalid: ${r.day}` });
  }
  const ids = db.select({ id: members.id }).from(members).all().map((m) => m.id);
  for (const r of rows) {
    if (!ids.includes(r.memberId)) return void res.status(400).json({ error: `anggota tidak dikenal: ${r.memberId}` });
    for (const j of [r.jamMulai ?? '09.00', r.jamSelesai ?? '15.00']) {
      if (!/^\d{2}\.\d{2}$/.test(j)) return void res.status(400).json({ error: `jam invalid: ${j}` });
    }
  }
  db.transaction((tx) => {
    tx.delete(roster).where(eq(roster.weekStart, start)).run();
    for (const r of rows) {
      tx.insert(roster).values({
        day: r.day, memberId: r.memberId,
        jamMulai: r.jamMulai ?? '09.00', jamSelesai: r.jamSelesai ?? '15.00',
        weekStart: start,
      }).run();
    }
  });
  res.json({ ok: true });
});

// Buang override 1 minggu → kembali mengikuti template dasar lagi.
app.delete('/api/roster/week', requireAdmin, (req, res) => {
  const start = String(req.query.start ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return void res.status(400).json({ error: 'start=YYYY-MM-DD (Senin minggu ybs)' });
  db.delete(roster).where(eq(roster.weekStart, start)).run();
  res.json({ ok: true });
});

// ---- checklist per tanggal (auto-clone dari template) ----
app.get('/api/checks', (req, res) => {
  const date = String(req.query.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return void res.status(400).json({ error: 'date=YYYY-MM-DD' });
  let rows = db.select().from(tasks).where(eq(tasks.tanggal, date)).all();
  if (rows.length === 0) {
    const tpl = db.select().from(tasks).where(eq(tasks.tanggal, 'template')).all();
    for (const t of tpl) db.insert(tasks).values({ tanggal: date, judul: t.judul, done: 0, sort: t.sort }).run();
    rows = db.select().from(tasks).where(eq(tasks.tanggal, date)).all();
  }
  res.json(rows.sort((a, b) => a.sort - b.sort));
});

app.post('/api/checks/toggle', (req, res) => {
  const { date, judul } = req.body as { date: string; judul: string };
  const row = db.select().from(tasks).where(eq(tasks.tanggal, date)).all().find((t) => t.judul === judul);
  if (!row) return void res.status(404).json({ error: 'tugas tidak ditemukan' });
  db.update(tasks).set({ done: row.done ? 0 : 1 }).where(eq(tasks.id, row.id)).run();
  res.json({ ok: true, done: row.done ? 0 : 1 });
});

// ---- tukar piket ----
const memberName = (id: string) =>
  db.select().from(members).where(eq(members.id, id)).all()[0]?.nama ?? id;

app.post('/api/swaps', (req, res) => {
  const { requester, target, fromDay, toDay, alasan } = req.body;
  if (!requester || !target || requester === target) return void res.status(400).json({ error: 'requester/target invalid' });
  if (!DAYS.includes(fromDay) || !DAYS.includes(toDay) || fromDay === toDay) {
    return void res.status(400).json({ error: 'fromDay/toDay invalid' });
  }
  const id = Math.random().toString(36).slice(2, 10);
  db.insert(swaps).values({
    id, requester, target, fromDay, toDay, alasan: alasan ?? '',
    status: 'pending', createdAt: Date.now(),
  }).run();
  void sendPush(target, 'Permintaan tukar piket',
    `${memberName(requester)} meminta tukar: ${fromDay} ⇄ ${toDay}`, '/#tukar');
  res.json({ ok: true, id });
});

// Yang berhak memutuskan = yang DIMINTA (target), atau Admin (override).
app.post('/api/swaps/:id/decide', (req, res) => {
  const { approve, by } = req.body as { approve: boolean; by: string };
  const row = db.select().from(swaps).where(eq(swaps.id, req.params.id)).all()[0];
  if (!row) return void res.status(404).json({ error: 'swap tidak ditemukan' });
  if (row.status !== 'pending') return void res.status(400).json({ error: 'sudah diputuskan' });
  const isAdmin = req.header('x-admin-pin') === ADMIN_PIN;
  if (!isAdmin && by !== row.target) {
    return void res.status(403).json({ error: 'hanya yang diminta / Admin' });
  }
  db.update(swaps).set({ status: approve ? 'approved' : 'rejected' }).where(eq(swaps.id, row.id)).run();
  void sendPush(row.requester, approve ? 'Tukar disetujui' : 'Tukar ditolak',
    `${memberName(row.target)} ${approve ? 'menerima' : 'menolak'} tukar: ${row.fromDay} ⇄ ${row.toDay}`, '/#tukar');
  if (approve) {
    // Tukar 1 orang antar dua hari — hanya di TEMPLATE dasar (minggu berjalan
    // ikut default). Override minggu depan/lain (hasil drag-drop) tidak disentuh.
    const fromRows = db.select().from(roster).where(and(eq(roster.day, row.fromDay), isNull(roster.weekStart))).all();
    const toRows = db.select().from(roster).where(and(eq(roster.day, row.toDay), isNull(roster.weekStart))).all();
    for (const r of fromRows.filter((x) => x.memberId === row.requester)) {
      db.update(roster).set({ memberId: row.target }).where(eq(roster.id, r.id)).run();
    }
    for (const r of toRows.filter((x) => x.memberId === row.target)) {
      db.update(roster).set({ memberId: row.requester }).where(eq(roster.id, r.id)).run();
    }
  }
  res.json({ ok: true });
});

// Pemohon boleh batalkan pengajuannya sendiri.
app.post('/api/swaps/:id/cancel', (req, res) => {
  const { by } = req.body as { by: string };
  const row = db.select().from(swaps).where(eq(swaps.id, req.params.id)).all()[0];
  if (!row) return void res.status(404).json({ error: 'swap tidak ditemukan' });
  if (row.status !== 'pending') return void res.status(400).json({ error: 'sudah diputuskan' });
  const isAdmin = req.header('x-admin-pin') === ADMIN_PIN;
  if (!isAdmin && by !== row.requester) {
    return void res.status(403).json({ error: 'hanya pemohon / Admin' });
  }
  db.update(swaps).set({ status: 'cancelled' }).where(eq(swaps.id, row.id)).run();
  void sendPush(row.target, 'Pengajuan tukar dibatalkan',
    `${memberName(row.requester)} membatalkan tukar: ${row.fromDay} ⇄ ${row.toDay}`, '/#tukar');
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---- web push (VAPID). Kunci: env > server/.vapid.json > generate sekali ----
const VAPID_FILE = './server/.vapid.json';
let VAPID_PUBLIC = process.env.VAPID_PUBLIC ?? '';
let VAPID_PRIVATE = process.env.VAPID_PRIVATE ?? '';
if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  try {
    const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')) as { publicKey: string; privateKey: string };
    VAPID_PUBLIC = VAPID_PUBLIC || saved.publicKey;
    VAPID_PRIVATE = VAPID_PRIVATE || saved.privateKey;
  } catch { /* belum ada */ }
}
if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC = keys.publicKey;
  VAPID_PRIVATE = keys.privateKey;
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  console.log('🔑 VAPID keys dibuat di server/.vapid.json');
}
webpush.setVapidDetails('mailto:piket@menwa.local', VAPID_PUBLIC, VAPID_PRIVATE);

const sendPush = async (memberId: string, title: string, body: string, url = '/') => {
  const subs = db.select().from(pushSubs).where(eq(pushSubs.memberId, memberId)).all();
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.sub), JSON.stringify({ title, body, url }));
    } catch {
      try { db.delete(pushSubs).where(eq(pushSubs.endpoint, s.endpoint)).run(); } catch { /* abaikan */ }
    }
  }
};

app.get('/api/push/public-key', (_req, res) => res.json({ publicKey: VAPID_PUBLIC }));

app.post('/api/push/subscribe', (req, res) => {
  const { memberId, subscription } = (req.body ?? {}) as { memberId: string; subscription: unknown };
  const sub = subscription as { endpoint?: string } | null;
  const member = db.select({ id: members.id }).from(members).where(eq(members.id, memberId)).all()[0];
  if (!member || !sub?.endpoint) return void res.status(400).json({ error: 'subscribe invalid' });
  db.insert(pushSubs)
    .values({ endpoint: sub.endpoint, memberId, sub: JSON.stringify(subscription), createdAt: Date.now() })
    .onConflictDoUpdate({ target: pushSubs.endpoint, set: { memberId, sub: JSON.stringify(subscription) } })
    .run();
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = (req.body ?? {}) as { endpoint?: string };
  if (endpoint) db.delete(pushSubs).where(eq(pushSubs.endpoint, endpoint)).run();
  res.json({ ok: true });
});

// ---- presence: heartbeat tiap 30 dtk, online bila < 90 dtk ----
app.post('/api/presence', (req, res) => {
  const { memberId } = (req.body ?? {}) as { memberId: string };
  const exists = db.select({ id: members.id }).from(members).where(eq(members.id, memberId)).all()[0];
  if (!exists) return void res.status(400).json({ error: 'anggota invalid' });
  db.update(members).set({ lastSeen: Date.now() }).where(eq(members.id, memberId)).run();
  res.json({ ok: true });
});

// ---- pendaftaran mandiri: wajah + nama (terbuka, tanpa login) ----
const PALETTE = ['#a78bfa', '#38bdf8', '#34d399', '#fbbf24', '#f87171', '#f472b6'];
const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'anggota';

const validDescriptors = (descriptors: unknown): descriptors is number[][] =>
  Array.isArray(descriptors) && descriptors.length >= 1 && descriptors.length <= 3
  && descriptors.every((d) => Array.isArray(d) && d.length === 128
    && (d as unknown[]).every((x) => typeof x === 'number' && Number.isFinite(x)));

const saveDataUrl = (dataUrl: string, dest: string): string | null => {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl ?? '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return dest;
};

const shaPin = (pin: string) => createHash('sha256').update(pin).digest('hex');

// Aturan PIN: ≥6 digit, bukan angka sama semua, bukan urutan, bukan tahun angkatan.
const pinError = (pin: string, angkatan: string): string | null => {
  if (!/^\d{6,}$/.test(pin ?? '')) return 'PIN minimal 6 digit angka';
  if (/^(\d)\1+$/.test(pin)) return 'PIN tidak boleh angka sama semua';
  const asc = '01234567890123456789';
  const desc = '98765432109876543210';
  for (let i = 0; i + 6 <= pin.length; i++) {
    const s = pin.slice(i, i + 6);
    if (asc.includes(s) || desc.includes(s)) return 'PIN tidak boleh berurutan';
  }
  if (angkatan && pin.includes(angkatan)) return 'PIN tidak boleh mengandung tahun angkatan';
  return null;
};

app.post('/api/register', (req, res) => {
  const { nama, angkatan, jabatan, pin, descriptors, foto } = (req.body ?? {}) as {
    nama: string; angkatan: string; jabatan: string; pin: string; descriptors: unknown; foto: string;
  };
  const clean = (nama ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
  if (clean.length < 5) return void res.status(400).json({ error: 'nama minimal 5 huruf' });
  const year = (angkatan ?? '').trim();
  const yNum = Number(year);
  if (!/^\d{4}$/.test(year) || yNum < 2000 || yNum > new Date().getFullYear() + 1) {
    return void res.status(400).json({ error: 'angkatan harus tahun 4 digit yang wajar' });
  }
  const jab = (jabatan ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (jab.length < 2) return void res.status(400).json({ error: 'jabatan minimal 2 huruf' });
  const pinErr = pinError(pin, year);
  if (pinErr) return void res.status(400).json({ error: pinErr });
  if (db.select({ id: members.id }).from(members).where(eq(members.pinHash, shaPin(pin))).all()[0]) {
    return void res.status(400).json({ error: 'PIN sudah dipakai' });
  }
  if (!validDescriptors(descriptors)) return void res.status(400).json({ error: 'wajah invalid (burst dulu)' });
  let id = slugify(clean);
  for (let n = 2; db.select().from(members).where(eq(members.id, id)).all()[0]; n++) id = `${slugify(clean)}-${n}`;
  const fotoFile = saveDataUrl(foto ?? '', path.join(UPLOAD_DIR, 'faces', `${id}.jpg`));
  if (!fotoFile) return void res.status(400).json({ error: 'foto wajah wajib' });
  const count = db.select().from(members).all().length;
  db.insert(members).values({
    id, nama: clean, warna: PALETTE[count % PALETTE.length], divisi: 'acara',
    foto: `/uploads/faces/${id}.jpg`, angkatan: year, jabatan: jab, pinHash: shaPin(pin),
  }).run();
  db.insert(faces).values({ memberId: id, descriptors: JSON.stringify(descriptors), updatedAt: Date.now() }).run();
  res.json({ ok: true, memberId: id, nama: clean });
});

// ---- PIN login (alternatif wajah; absensi/check-in TETAP wajah) ----
app.post('/api/login/pin', (req, res) => {
  const { pin } = (req.body ?? {}) as { pin: string };
  if (!/^\d{6,}$/.test(pin ?? '')) return void res.status(400).json({ error: 'PIN minimal 6 digit' });
  const m = db.select().from(members).where(eq(members.pinHash, shaPin(pin))).all()[0];
  if (!m) return void res.status(401).json({ error: 'PIN salah' });
  res.json({ ok: true, memberId: m.id, nama: m.nama });
});

// Atur/ganti PIN sendiri (sudah login = sudah verifikasi wajah).
app.post('/api/pin/set', (req, res) => {
  const { memberId, pin } = (req.body ?? {}) as { memberId: string; pin: string };
  const member = db.select().from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  const err = pinError(pin, member.angkatan ?? '');
  if (err) return void res.status(400).json({ error: err });
  const taken = db.select({ id: members.id }).from(members).where(eq(members.pinHash, shaPin(pin))).all()[0];
  if (taken && taken.id !== memberId) return void res.status(400).json({ error: 'PIN sudah dipakai' });
  db.update(members).set({ pinHash: shaPin(pin) }).where(eq(members.id, memberId)).run();
  res.json({ ok: true });
});

// ---- hapus anggota (Admin): bersih + file ikut dibuang ----
// Hapus anggota (+semua data & file) = SUPERADMIN saja.
app.delete('/api/members/:id', (req, res) => {
  if (req.header('x-super-pin') !== SUPER_PIN) {
    return void res.status(403).json({ error: 'khusus superadmin' });
  }
  const id = req.params.id;
  db.transaction((tx) => {
    const aids = tx.select({ id: assessments.id }).from(assessments).where(eq(assessments.memberId, id)).all();
    for (const a of aids) {
      const iids = tx.select({ id: assessmentItems.id }).from(assessmentItems)
        .where(eq(assessmentItems.assessmentId, a.id)).all();
      for (const it of iids) tx.delete(itemKoreksi).where(eq(itemKoreksi.itemId, it.id)).run();
      tx.delete(assessmentItems).where(eq(assessmentItems.assessmentId, a.id)).run();
    }
    tx.delete(assessments).where(eq(assessments.memberId, id)).run();
    tx.delete(kehadiran).where(eq(kehadiran.memberId, id)).run();
    tx.delete(pushSubs).where(eq(pushSubs.memberId, id)).run();
    tx.delete(lapsit).where(eq(lapsit.memberId, id)).run();
    tx.delete(attendance).where(eq(attendance.memberId, id)).run();
    tx.delete(evidence).where(eq(evidence.memberId, id)).run();
    tx.delete(faces).where(eq(faces.memberId, id)).run();
    tx.delete(roster).where(eq(roster.memberId, id)).run();
    tx.delete(members).where(eq(members.id, id)).run();
  });
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR, { recursive: true }) as string[]) {
      const base = path.basename(f);
      if (base === `${id}.jpg` || base.includes(`_${id}_`)) fs.unlinkSync(path.join(UPLOAD_DIR, f));
    }
  } catch { /* best effort */ }
  res.json({ ok: true });
});
app.get('/api/faces', (_req, res) => {
  res.json(db.select().from(faces).all());
});

app.post('/api/faces', requireAdmin, (req, res) => {
  const { memberId, descriptors } = (req.body ?? {}) as { memberId: string; descriptors: unknown };
  const member = db.select().from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  const valid = Array.isArray(descriptors) && descriptors.length >= 1 && descriptors.length <= 3
    && descriptors.every((d) => Array.isArray(d) && d.length === 128
      && (d as unknown[]).every((x) => typeof x === 'number' && Number.isFinite(x)));
  if (!valid) return void res.status(400).json({ error: 'descriptors invalid (1-3 x 128 angka)' });
  const existing = db.select().from(faces).where(eq(faces.memberId, memberId)).all()[0];
  if (existing) {
    db.update(faces).set({ descriptors: JSON.stringify(descriptors), updatedAt: Date.now() })
      .where(eq(faces.memberId, memberId)).run();
  } else {
    db.insert(faces).values({ memberId, descriptors: JSON.stringify(descriptors), updatedAt: Date.now() }).run();
  }
  res.json({ ok: true });
});

app.delete('/api/faces/:memberId', requireAdmin, (req, res) => {
  db.delete(faces).where(eq(faces.memberId, req.params.memberId)).run();
  res.json({ ok: true });
});

// ---- absen tiba (terbuka; diklaim setelah verifikasi wajah lolos di HP) ----
app.get('/api/attendance', (req, res) => {
  const { date, from, to } = req.query as Record<string, string | undefined>;
  let rows = db.select().from(attendance).all();
  if (date) rows = rows.filter((r) => r.tanggal === date);
  if (from && to) rows = rows.filter((r) => r.tanggal >= from && r.tanggal <= to);
  res.json(rows);
});

const onDutyAt = (tanggal: string, memberId: string): string | null => {
  const dow = new Date(tanggal + 'T00:00').getDay();
  if (dow < 1 || dow > 5) return null;
  const ok = db.select().from(roster).where(eq(roster.day, DAYS[dow - 1])).all()
    .some((r) => r.memberId === memberId);
  return ok ? memberId : null;
};

app.post('/api/attendance', (req, res) => {
  const { tanggal, memberId } = (req.body ?? {}) as { tanggal: string; memberId: string };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal ?? '')) return void res.status(400).json({ error: 'tanggal invalid' });
  const member = db.select().from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  if (!onDutyAt(tanggal, memberId)) return void res.status(400).json({ error: `${member.nama} tidak piket di tanggal itu` });
  const already = db.select().from(attendance).all()
    .some((r) => r.tanggal === tanggal && r.memberId === memberId);
  if (already) return void res.json({ ok: true, already: true });
  const now = new Date();
  const jam = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`;
  db.insert(attendance).values({ tanggal, memberId, jam, createdAt: Date.now() }).run();
  // Sinkron ke tabel kehadiran (tidak menimpa izin/sakit/alpa yang sudah ada).
  const kh = db.select().from(kehadiran).where(eq(kehadiran.tanggal, tanggal)).all()
    .find((k) => k.memberId === memberId);
  if (!kh) {
    db.insert(kehadiran).values({ tanggal, memberId, status: 'hadir', acc: null, by: memberId, at: Date.now() }).run();
  }
  res.json({ ok: true, jam });
});

// ---- bukti per tugas (1 foto per judul tugas per tanggal, shared) ----
app.get('/api/evidence', (req, res) => {
  const { date, from, to } = req.query as Record<string, string | undefined>;
  let rows = db.select().from(evidence).all();
  if (date) rows = rows.filter((r) => r.tanggal === date);
  if (from && to) rows = rows.filter((r) => r.tanggal >= from && r.tanggal <= to);
  res.json(rows);
});

// Pastikan baris checklist tanggal itu ada (clone dari template bila baru).
const ensureChecks = (tanggal: string) => {
  let rows = db.select().from(tasks).where(eq(tasks.tanggal, tanggal)).all();
  if (rows.length === 0) {
    const tpl = db.select().from(tasks).where(eq(tasks.tanggal, 'template')).all();
    for (const t of tpl) db.insert(tasks).values({ tanggal, judul: t.judul, done: 0, sort: t.sort }).run();
    rows = db.select().from(tasks).where(eq(tasks.tanggal, tanggal)).all();
  }
  return rows.sort((a, b) => a.sort - b.sort);
};

app.post('/api/evidence', (req, res) => {
  const { tanggal, memberId, tugas, dataUrl } = (req.body ?? {}) as {
    tanggal: string; memberId: string; tugas: string; dataUrl: string;
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal ?? '')) return void res.status(400).json({ error: 'tanggal invalid' });
  const member = db.select().from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  const dow = new Date(tanggal + 'T00:00').getDay();
  const dayName = dow >= 1 && dow <= 5 ? DAYS[dow - 1] : null;
  const onDuty = dayName
    && db.select().from(roster).where(eq(roster.day, dayName)).all().some((r) => r.memberId === memberId);
  if (!onDuty) return void res.status(400).json({ error: `${member.nama} tidak piket di tanggal itu` });
  const task = ensureChecks(tanggal).find((t) => t.judul === tugas);
  const master = !task
    ? db.select().from(tugasMaster).where(eq(tugasMaster.judul, tugas)).all()[0]
    : null;
  if (!task && !master) return void res.status(400).json({ error: 'foto harus sesuai judul tugas' });
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl ?? '');
  if (!m) return void res.status(400).json({ error: 'foto invalid' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return void res.status(400).json({ error: 'foto >5MB' });
  const slug = tugas.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'foto';
  const fname = task ? `${tanggal}_task${task.id}.jpg` : `${tanggal}_${slug}.jpg`;
  const existing = db.select().from(evidence).all()
    .find((r) => r.tanggal === tanggal && r.tugas === tugas);
  if (existing) {
    return void res.status(400).json({ error: 'foto sudah diterima, tidak perlu 2x' });
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  const file = `/uploads/${fname}`;
  db.insert(evidence).values({ tanggal, tugas, memberId, file, createdAt: Date.now() }).run();
  if (task) db.update(tasks).set({ done: 1 }).where(eq(tasks.id, task.id)).run(); // upload = selesai
  res.json({ ok: true, file });
});

// ---- lapsit akhir piket (wajib 4 foto dulu, stempel waktu+koordinat) ----
app.get('/api/lapsit', (req, res) => {
  const { date, from, to } = req.query as Record<string, string | undefined>;
  let rows = db.select().from(lapsit).all();
  if (date) rows = rows.filter((r) => r.tanggal === date);
  if (from && to) rows = rows.filter((r) => r.tanggal >= from && r.tanggal <= to);
  res.json(rows.sort((a, b) => b.createdAt - a.createdAt));
});

app.post('/api/lapsit', (req, res) => {
  const { tanggal, memberId, catatan, lat, lng, acc } = (req.body ?? {}) as {
    tanggal: string; memberId: string; catatan: string;
    lat?: string | null; lng?: string | null; acc?: number | null;
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal ?? '')) return void res.status(400).json({ error: 'tanggal invalid' });
  const member = db.select().from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  if (!onDutyAt(tanggal, memberId)) return void res.status(400).json({ error: `${member.nama} tidak piket di tanggal itu` });
  const note = (catatan ?? '').trim().replace(/\s+/g, ' ').slice(0, 500);
  if (note.length < 5) return void res.status(400).json({ error: 'catatan minimal 5 huruf' });
  const need = db.select().from(tasks).where(eq(tasks.tanggal, 'template')).all().length;
  const got = new Set(
    db.select().from(evidence).where(eq(evidence.tanggal, tanggal)).all().map((e) => e.tugas),
  ).size;
  if (got < need) return void res.status(400).json({ error: `lengkapi ${need} foto bukti dulu (baru ${got})` });
  const already = db.select().from(lapsit).where(eq(lapsit.tanggal, tanggal)).all()[0];
  if (already) return void res.status(400).json({ error: 'lapsit hari ini sudah dikirim' });
  const row = db.insert(lapsit).values({
    tanggal, memberId, catatan: note,
    lat: lat ?? null, lng: lng ?? null,
    acc: typeof acc === 'number' ? Math.round(acc) : null,
    createdAt: Date.now(),
  }).run();
  res.json({ ok: true, id: Number(row.lastInsertRowid) });
});

// ================= PENILAIAN PER ORANG =================
const getSetting = (key: string): string | null =>
  db.select().from(settings).where(eq(settings.key, key)).all()[0]?.value ?? null;

const nilaiOf = (items: { bobot: number; status: string }[]) => hitungNilai(items);

const ensureAssessment = (tanggal: string, memberId: string) => {
  let a = db.select().from(assessments)
    .where(eq(assessments.tanggal, tanggal)).all()
    .find((x) => x.memberId === memberId);
  if (a) return a;
  const id = db.insert(assessments).values({ tanggal, memberId, status: 'draft' }).run().lastInsertRowid as number;
  for (const m of NILAI_MASTER) {
    db.insert(assessmentItems).values({
      assessmentId: id, no: m.no, kategori: m.kategori, judul: m.judul,
      bobot: m.bobot, jenis: m.jenis, fotoWajib: m.fotoWajib ? 1 : 0, status: 'tidak',
    }).run();
  }
  a = db.select().from(assessments).where(eq(assessments.id, id)).all()[0];
  return a;
};

app.get('/api/nilai/master', (_req, res) => {
  res.json(db.select().from(tugasMaster).all().sort((a, b) => a.no - b.no));
});

// Baca/buat assessment saya. Auto-create hanya bila piket hari itu.
app.get('/api/nilai', (req, res) => {
  const { date, memberId } = req.query as Record<string, string | undefined>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !memberId) {
    return void res.status(400).json({ error: 'date & memberId wajib' });
  }
  const member = db.select({ id: members.id }).from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  const existing = db.select().from(assessments).where(eq(assessments.tanggal, date)).all()
    .find((x) => x.memberId === memberId);
  if (existing) {
    const items = db.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, existing.id)).all()
      .sort((a, b) => a.no - b.no);
    return void res.json({ assessment: existing, items, preview: nilaiOf(items) });
  }
  if (!onDutyAt(date, memberId)) {
    return void res.status(404).json({ error: 'belum ada penilaian (tidak piket hari itu?)' });
  }
  const a = ensureAssessment(date, memberId);
  const items = db.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, a.id)).all()
    .sort((x, y) => x.no - y.no);
  res.json({ assessment: a, items, preview: nilaiOf(items) });
});

// Isi/ubah item (milik sendiri, belum verified).
app.post('/api/nilai/items', (req, res) => {
  const { assessmentId, by, items } = req.body as {
    assessmentId: number; by: string; items: { itemId: number; status: string }[];
  };
  const a = db.select().from(assessments).where(eq(assessments.id, assessmentId)).all()[0];
  if (!a) return void res.status(404).json({ error: 'assessment tidak ada' });
  if (a.memberId !== by) return void res.status(403).json({ error: 'hanya pemilik' });
  if (a.status === 'verified') return void res.status(400).json({ error: 'sudah final' });
  if (!Array.isArray(items) || items.length === 0) return void res.status(400).json({ error: 'items kosong' });
  // Validasi dulu semuanya (atomik: tidak ada yang kesimpen bila 1 gagal).
  const rows = new Map<number, { no: number; jenis: string; fotoWajib: number; judul: string }>();
  for (const it of items) {
    if (!['selesai', 'tidak', 'na'].includes(it.status)) {
      return void res.status(400).json({ error: `status invalid: ${it.status}` });
    }
    const row = db.select().from(assessmentItems).where(eq(assessmentItems.id, it.itemId)).all()[0];
    if (!row || row.assessmentId !== assessmentId) {
      return void res.status(400).json({ error: 'item invalid' });
    }
    if (it.status === 'na' && row.jenis !== 'Kondisional') {
      return void res.status(400).json({ error: `N/A hanya untuk Kondisional (no ${row.no})` });
    }
    if (it.status === 'selesai' && row.fotoWajib) {
      const ada = db.select().from(evidence).where(eq(evidence.tanggal, a.tanggal)).all()
        .some((e) => e.tugas === row.judul);
      if (!ada) return void res.status(400).json({ error: `wajib foto: ${row.judul}` });
    }
    rows.set(it.itemId, row);
  }
  try {
    db.transaction((tx) => {
      for (const it of items) {
        tx.update(assessmentItems).set({ status: it.status }).where(eq(assessmentItems.id, it.itemId)).run();
      }
    });
  } catch {
    return void res.status(400).json({ error: 'N/A hanya untuk Kondisional' });
  }
  const all = db.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, assessmentId)).all();
  res.json({ ok: true, preview: nilaiOf(all) });
});

// Ajukan penilaian → pending.
app.post('/api/nilai/submit', (req, res) => {
  const { assessmentId, by } = req.body as { assessmentId: number; by: string };
  const a = db.select().from(assessments).where(eq(assessments.id, assessmentId)).all()[0];
  if (!a) return void res.status(404).json({ error: 'assessment tidak ada' });
  if (a.memberId !== by) return void res.status(403).json({ error: 'hanya pemilik' });
  if (a.status === 'verified') return void res.status(400).json({ error: 'sudah final' });
  const items = db.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, assessmentId)).all();
  for (const row of items) {
    if (row.status === 'na' && row.jenis !== 'Kondisional') {
      return void res.status(400).json({ error: `N/A hanya untuk Kondisional (no ${row.no})` });
    }
    if (row.status === 'selesai' && row.fotoWajib) {
      const ada = db.select().from(evidence).where(eq(evidence.tanggal, a.tanggal)).all()
        .some((e) => e.tugas === row.judul);
      if (!ada) return void res.status(400).json({ error: `wajib foto: ${row.judul}` });
    }
  }
  db.update(assessments).set({ status: 'pending', submittedAt: Date.now() })
    .where(eq(assessments.id, assessmentId)).run();
  res.json({ ok: true, preview: nilaiOf(items) });
});

// Antrean verifikasi (ketua/wakil).
app.get('/api/nilai/pending', (req, res) => {
  const by = String(req.query.by ?? '');
  const ketua = getSetting('ketua_id');
  const wakil = getSetting('wakil_id');
  if (!ketua || (by !== ketua && by !== wakil)) {
    return void res.status(403).json({ error: 'khusus ketua/wakil' });
  }
  const rows = db.select().from(assessments).where(eq(assessments.status, 'pending')).all()
    .sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
  const H2 = 2 * 86400000;
  res.json(rows.map((a) => ({
    ...a,
    memberNama: db.select().from(members).where(eq(members.id, a.memberId)).all()[0]?.nama ?? a.memberId,
    preview: nilaiOf(db.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, a.id)).all()),
    overdue: Date.now() - (a.submittedAt ?? Date.now()) > H2,
  })));
});

// Verifikasi ketua: approve (+koreksi opsional) atau tolak → draft.
// Berhak: ketua, kecuali yang dinilai = ketua → wakil.
app.post('/api/nilai/verify', (req, res) => {
  const { assessmentId, by, approve, corrections } = req.body as {
    assessmentId: number; by: string; approve: boolean;
    corrections?: { itemId: number; status: string; catatan: string }[];
  };
  const a = db.select().from(assessments).where(eq(assessments.id, assessmentId)).all()[0];
  if (!a) return void res.status(404).json({ error: 'assessment tidak ada' });
  if (a.status !== 'pending') return void res.status(400).json({ error: 'bukan antrean pending' });
  const ketua = getSetting('ketua_id');
  const wakil = getSetting('wakil_id');
  const needWakil = ketua && a.memberId === ketua;
  if (needWakil ? by !== wakil : by !== ketua) {
    return void res.status(403).json({ error: needWakil ? 'dinilai ketua → verifikator harus wakil' : 'khusus ketua' });
  }
  if (!approve) {
    db.update(assessments).set({ status: 'draft', submittedAt: null }).where(eq(assessments.id, assessmentId)).run();
    return void res.json({ ok: true, kembali: 'draft' });
  }
  // Validasi semua koreksi dulu (atomik).
  const corrRows: { row: { id: number; no: number; jenis: string; status: string }; status: string; catatan: string }[] = [];
  for (const c of corrections ?? []) {
    if (!['selesai', 'tidak', 'na'].includes(c.status)) {
      return void res.status(400).json({ error: 'status koreksi invalid' });
    }
    const row = db.select().from(assessmentItems).where(eq(assessmentItems.id, c.itemId)).all()[0];
    if (!row || row.assessmentId !== assessmentId) return void res.status(400).json({ error: 'item koreksi invalid' });
    if (row.status === c.status) continue;
    if (!c.catatan?.trim()) return void res.status(400).json({ error: `koreksi no ${row.no} wajib catatan` });
    if (c.status === 'na' && row.jenis !== 'Kondisional') {
      return void res.status(400).json({ error: `N/A hanya untuk Kondisional (no ${row.no})` });
    }
    corrRows.push({ row, status: c.status, catatan: c.catatan.trim().slice(0, 300) });
  }
  try {
    db.transaction((tx) => {
      for (const { row, status, catatan } of corrRows) {
        tx.insert(itemKoreksi).values({
          itemId: row.id, statusLama: row.status, statusBaru: status,
          catatan, by, at: Date.now(),
        }).run();
        tx.update(assessmentItems).set({ status }).where(eq(assessmentItems.id, row.id)).run();
      }
      const items = tx.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, assessmentId)).all();
      const nilai = nilaiOf(items);
      tx.update(assessments)
        .set({ status: 'verified', nilai, verifiedBy: by, verifiedAt: Date.now() })
        .where(eq(assessments.id, assessmentId)).run();
    });
  } catch {
    return void res.status(400).json({ error: `N/A hanya untuk Kondisional` });
  }
  const items = db.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, assessmentId)).all();
  const nilai = nilaiOf(items);
  res.json({ ok: true, nilai });
});

// Jejak koreksi 1 assessment.
app.get('/api/nilai/koreksi', (req, res) => {
  const assessmentId = Number(req.query.assessmentId);
  const items = db.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, assessmentId)).all();
  const ids = new Set(items.map((i) => i.id));
  const rows = db.select().from(itemKoreksi).all()
    .filter((k) => ids.has(k.itemId))
    .sort((a, b) => a.at - b.at);
  res.json(rows);
});

// ---- kehadiran ----
app.post('/api/kehadiran/request', (req, res) => {
  const { tanggal, memberId, status } = req.body as { tanggal: string; memberId: string; status: string };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal ?? '')) return void res.status(400).json({ error: 'tanggal invalid' });
  if (status !== 'izin' && status !== 'sakit') return void res.status(400).json({ error: 'hanya izin/sakit' });
  const member = db.select({ id: members.id }).from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  if (!onDutyAt(tanggal, memberId)) return void res.status(400).json({ error: 'tidak piket di tanggal itu' });
  const ex = db.select().from(kehadiran).where(eq(kehadiran.tanggal, tanggal)).all()
    .find((k) => k.memberId === memberId);
  if (ex) {
    db.update(kehadiran).set({ status, acc: 'pending', by: memberId, at: Date.now() })
      .where(eq(kehadiran.id, ex.id)).run();
  } else {
    db.insert(kehadiran).values({ tanggal, memberId, status, acc: 'pending', by: memberId, at: Date.now() }).run();
  }
  res.json({ ok: true });
});

app.post('/api/kehadiran/decide', requireAdmin, (req, res) => {
  const { tanggal, memberId, approve } = req.body as { tanggal: string; memberId: string; approve: boolean };
  const ex = db.select().from(kehadiran).where(eq(kehadiran.tanggal, tanggal)).all()
    .find((k) => k.memberId === memberId);
  if (!ex || ex.acc !== 'pending') return void res.status(400).json({ error: 'tidak ada pengajuan pending' });
  if (approve) {
    db.update(kehadiran).set({ acc: 'acc', at: Date.now() }).where(eq(kehadiran.id, ex.id)).run();
  } else {
    db.update(kehadiran).set({ status: 'hadir', acc: null, at: Date.now() }).where(eq(kehadiran.id, ex.id)).run();
  }
  res.json({ ok: true });
});

app.post('/api/kehadiran/set', requireAdmin, (req, res) => {
  const { tanggal, memberId, status } = req.body as { tanggal: string; memberId: string; status: string };
  if (!['hadir', 'alpa'].includes(status)) return void res.status(400).json({ error: 'hanya hadir/alpa' });
  const ex = db.select().from(kehadiran).where(eq(kehadiran.tanggal, tanggal)).all()
    .find((k) => k.memberId === memberId);
  if (ex) {
    db.update(kehadiran).set({ status, acc: null, at: Date.now() }).where(eq(kehadiran.id, ex.id)).run();
  } else {
    db.insert(kehadiran).values({ tanggal, memberId, status, acc: null, by: 'admin', at: Date.now() }).run();
  }
  res.json({ ok: true });
});

// ---- rekap nilai (?from&to, opsional ?memberId=) ----
app.get('/api/nilai/rekap', (req, res) => {
  const { from, to, memberId } = req.query as Record<string, string | undefined>;
  let list = db.select().from(assessments).all();
  if (from && to) list = list.filter((a) => a.tanggal >= from && a.tanggal <= to);
  if (memberId) list = list.filter((a) => a.memberId === memberId);
  const khOf = (tanggal: string, mid: string) =>
    db.select().from(kehadiran).where(eq(kehadiran.tanggal, tanggal)).all().find((k) => k.memberId === mid);
  const rows = list.map((a) => {
    const kh = khOf(a.tanggal, a.memberId);
    let nilai: number | null = a.nilai ?? null;
    let ket = a.status;
    if (a.status === 'verified') {
      if (kh && (kh.status === 'izin' || kh.status === 'sakit') && kh.acc === 'acc') {
        nilai = null;
        ket = `dikecualikan (${kh.status})`;
      } else if (kh?.status === 'alpa') {
        nilai = 0;
        ket = 'alpa';
      }
    }
    return {
      tanggal: a.tanggal, memberId: a.memberId,
      memberNama: db.select().from(members).where(eq(members.id, a.memberId)).all()[0]?.nama ?? a.memberId,
      status: ket, nilai,
      kehadiran: kh?.status ?? 'hadir',
    };
  }).sort((a, b) => b.tanggal.localeCompare(a.tanggal));
  const vals = rows.map((r) => r.nilai).filter((n): n is number => typeof n === 'number');
  res.json({ rows, rata2: vals.length ? Math.round((vals.reduce((s, n) => s + n, 0) / vals.length) * 100) / 100 : null });
});

// ---- settings ketua/wakil (superadmin) ----
app.get('/api/settings', (_req, res) => {
  const out: Record<string, string> = {};
  for (const s of db.select().from(settings).all()) out[s.key] = s.value;
  res.json(out);
});

app.put('/api/settings', requireSuper, (req, res) => {
  const { ketua_id, wakil_id } = (req.body ?? {}) as Record<string, string | undefined>;
  for (const [k, v] of [['ketua_id', ketua_id], ['wakil_id', wakil_id]] as const) {
    if (v === undefined) continue;
    const member = db.select({ id: members.id }).from(members).where(eq(members.id, v)).all()[0];
    if (!member) return void res.status(400).json({ error: `anggota invalid: ${v}` });
    const ex = db.select().from(settings).where(eq(settings.key, k)).all()[0];
    if (ex) db.update(settings).set({ value: v }).where(eq(settings.key, k)).run();
    else db.insert(settings).values({ key: k, value: v }).run();
  }
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => console.log(`piket-menwa API :${port} (db=${process.env.DB_FILE ?? './dev.db'})`));