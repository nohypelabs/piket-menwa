import cors from 'cors';
import { and, eq, isNull } from 'drizzle-orm';
import express from 'express';
import fs from 'node:fs';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import webpush from 'web-push';
import { db } from '../db/client.ts';
import { attendance, evidence, faces, lapsit, members, pushSubs, roster, swaps, tasks, breakdown } from '../db/schema.sqlite.ts';
import {
  assessments, assessmentItems, attestIssued, itemKoreksi, kehadiran, settings, tugasMaster,
} from '../db/schema.sqlite.ts';
import { NILAI_MASTER, hitungNilai } from '../db/nilai_master.ts';
import { encryptJson, decryptJson } from '../db/crypto.ts';
import { identify as identifyFace, type Enrolled } from '../db/face_match.ts';

const app = express();
// CORS dibatasi via env saat produksi; dev tetap terbuka.
app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined));
app.use(express.json({ limit: '12mb' })); // foto dikirim sebagai dataURL terkompresi

// Rate-limit sederhana in-memory (per IP + path sensitif).
const buckets = new Map<string, { n: number; reset: number }>();
const rateLimit = (max: number, windowMs: number) => (
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
) => {
  const key = `${req.ip ?? 'x'}:${req.path}`;
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return next();
  }
  b.n += 1;
  if (b.n > max) return void res.status(429).json({ error: 'terlalu sering, coba lagi nanti' });
  next();
};

// File: ./uploads (nanti: Supabase Storage). Struktur sekarang:
//   uploads/profil/*  → avatar profil OPSIONAL (bukan data biometrik), tetap
//                        diserve publik apa adanya — risikonya rendah.
//   uploads/evidence/* → foto Bukti Piket, BUKAN publik. Akses cuma lewat
//                        signed URL (HMAC, expired 60 detik, lihat di bawah)
//                        supaya tidak ada link permanen yang bisa disebar.
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? './uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads/profil', express.static(path.resolve(UPLOAD_DIR, 'profil')));

// ---- secret policy: production WAJIB env, dev boleh default (berisik, tanpa nilai) ----
const IS_PROD = process.env.NODE_ENV === 'production';
const needEnv = (name: string, devFallback: string): string => {
  const v = process.env[name];
  if (v) return v;
  if (IS_PROD) {
    console.error(`FATAL: ${name} wajib diset di production — server tidak dijalankan.`);
    process.exit(1);
  }
  console.warn(`⚠️  ${name} belum diset — pakai default DEV. Jangan deploy begini!`);
  return devFallback;
};

// ---- signed URL utk foto bukti piket: HMAC(path, exp) pakai FACE_ENC_KEY ----
const SIGN_KEY = needEnv('FACE_ENC_KEY', 'dev-only-insecure-key-ganti-di-.env');
function signPath(relPath: string, expMs: number): string {
  const h = createHmac('sha256', SIGN_KEY).update(`${relPath}:${expMs}`).digest('hex');
  return h;
}
function makeSignedEvidenceUrl(relPath: string): string {
  const exp = Date.now() + 60_000; // 60 detik
  const sig = signPath(relPath, exp);
  return `/uploads-signed/${relPath}?exp=${exp}&sig=${sig}`;
}
app.get('/uploads-signed/evidence/:file', (req, res) => {
  const relPath = `evidence/${req.params.file}`;
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig ?? '');
  if (!exp || !sig || Date.now() > exp) return void res.status(403).send('link kedaluwarsa');
  const expected = signPath(relPath, exp);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return void res.status(403).send('signature invalid');
  res.sendFile(path.resolve(UPLOAD_DIR, relPath));
});

const DAYS = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'] as const;

// ---- role: user vs admin(ketua). Aksi admin wajib header x-admin-pin ----
const ADMIN_PIN = needEnv('ADMIN_PIN', '1234');

// ---- superadmin (dev): dashboard monitoring, PIN terpisah ----
const SUPER_PIN = needEnv('SUPER_PIN', '041294');
const requireSuper = (
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
) => {
  const got = req.header('x-super-pin') ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(SUPER_PIN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return void res.status(403).json({ error: 'butuh PIN superadmin' });
  }
  next();
};

const todayLocal = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

app.post('/api/super/verify', (req, res) => {
  res.json({ ok: pinEq(req.body?.pin, SUPER_PIN) });
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
  const got = req.header('x-admin-pin') ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(ADMIN_PIN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return void res.status(403).json({ error: 'butuh PIN Admin' });
  }
  next();
};

// Perbandingan PIN constant-time (anti timing-oracle).
const pinEq = (got: unknown, expected: string): boolean => {
  if (typeof got !== 'string' || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// ---- atestasi wajah: bukti lolos face-match hari ini ----
// Token = HMAC(memberId:tanggal), diterbitkan saat match lolos, berlaku
// hari itu untuk aksi member tsb (absen/evidence/lapsit). Tanpa ini server
// tidak percaya klaim memberId apa pun dari HP.
const attestToken = (memberId: string, tanggal: string): string =>
  createHmac('sha256', SIGN_KEY).update(`${memberId}:${tanggal}`).digest('hex');

const checkAttest = (token: unknown, memberId: string, tanggal: string): boolean => {
  if (typeof token !== 'string' || !token || !memberId || !tanggal) return false;
  const good = attestToken(memberId, tanggal);
  if (token.length !== good.length) return false;
  if (!timingSafeEqual(Buffer.from(token), Buffer.from(good))) return false;
  return db.select().from(attestIssued)
    .where(and(eq(attestIssued.memberId, memberId), eq(attestIssued.tanggal, tanggal))).all()
    .length > 0;
};

const issueAttest = (memberId: string, tanggal: string): string => {
  const ex = db.select().from(attestIssued)
    .where(and(eq(attestIssued.memberId, memberId), eq(attestIssued.tanggal, tanggal))).all()[0];
  if (!ex) db.insert(attestIssued).values({ memberId, tanggal, at: Date.now() }).run();
  return attestToken(memberId, tanggal);
};

app.post('/api/admin/verify', (req, res) => {
  res.json({ ok: pinEq(req.body?.pin, ADMIN_PIN) });
});

// ---- bootstrap: semua state dalam 1 call ----
app.get('/api/state', (_req, res) => {
  // pinHash TIDAK boleh bocor ke client (walau sudah di-hash, tetap rahasia).
  const publicMembers = db.select({
    id: members.id, nama: members.nama, warna: members.warna, divisi: members.divisi,
    foto: members.foto, angkatan: members.angkatan, jabatan: members.jabatan,
    lastSeen: members.lastSeen, noFaceConsent: members.noFaceConsent,
  }).from(members).all();
  res.json({
    members: publicMembers,
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

// ---- checklist per tanggal PER ORANG (auto-clone dari template) ----
app.get('/api/checks', (req, res) => {
  const date = String(req.query.date ?? '');
  const memberId = String(req.query.memberId ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return void res.status(400).json({ error: 'date=YYYY-MM-DD' });
  if (!memberId) return void res.status(400).json({ error: 'memberId wajib' });
  let rows = db.select().from(tasks).where(and(eq(tasks.tanggal, date), eq(tasks.memberId, memberId))).all();
  if (rows.length === 0) {
    const tpl = db.select().from(tasks).where(eq(tasks.tanggal, 'template')).all();
    for (const t of tpl) db.insert(tasks).values({ tanggal: date, memberId, judul: t.judul, done: 0, sort: t.sort }).run();
    rows = db.select().from(tasks).where(and(eq(tasks.tanggal, date), eq(tasks.memberId, memberId))).all();
  }
  res.json(rows.sort((a, b) => a.sort - b.sort));
});

app.post('/api/checks/toggle', (req, res) => {
  const { date, memberId, judul } = req.body as { date: string; memberId: string; judul: string };
  const row = db.select().from(tasks).where(and(eq(tasks.tanggal, date), eq(tasks.memberId, memberId))).all()
    .find((t) => t.judul === judul);
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
  const isAdmin = pinEq(req.header('x-admin-pin'), ADMIN_PIN);
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
  const isAdmin = pinEq(req.header('x-admin-pin'), ADMIN_PIN);
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

const hashPin = (pin: string): string => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}$${scryptSync(pin, salt, 32).toString('hex')}`;
};
const verifyPinHash = (pin: string, stored: string): boolean => {
  const [salt, h] = stored.split('$');
  if (!salt || !h) return false;
  const a = Buffer.from(scryptSync(pin, salt, 32).toString('hex'));
  const b = Buffer.from(h);
  return a.length === b.length && timingSafeEqual(a, b);
};
// Cari member by PIN (hash unik per user, jadi iterasi + verifikasi satu-satu).
// Format lama (sha256 tanpa garam, pra-migrasi): cocok → upgrade diam-diam ke scrypt.
const sha256legacy = (pin: string) => createHash('sha256').update(pin).digest('hex');
const findByPin = (pin: string) => {
  for (const m of db.select().from(members).all()) {
    if (!m.pinHash) continue;
    if (verifyPinHash(pin, m.pinHash)) return m;
    if (!m.pinHash.includes('$') && m.pinHash === sha256legacy(pin)) {
      const upgraded = hashPin(pin);
      db.update(members).set({ pinHash: upgraded }).where(eq(members.id, m.id)).run();
      return { ...m, pinHash: upgraded };
    }
  }
  return undefined;
};
const pinTaken = (pin: string, exceptId?: string): boolean => {
  const m = findByPin(pin);
  return !!m && m.id !== exceptId;
};

// Aturan PIN: minLen digit (default 6; 8 kalau tanpa wajah), bukan angka sama semua, bukan urutan, bukan tahun angkatan.
const pinError = (pin: string, angkatan: string, minLen = 6): string | null => {
  if (!new RegExp(`^\\d{${minLen},}$`).test(pin ?? '')) return `PIN minimal ${minLen} digit angka`;
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
  const { nama, angkatan, jabatan, pin, descriptors, noFaceConsent } = (req.body ?? {}) as {
    nama: string; angkatan: string; jabatan: string; pin: string; descriptors: unknown; noFaceConsent?: boolean;
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
  const noFace = noFaceConsent === true;
  // Tanpa consent wajah: PIN wajib LEBIH PANJANG (8 digit) karena jadi
  // satu-satunya faktor otentikasi akun (tidak ada verifikasi wajah cadangan).
  const pinErr = pinError(pin, year, noFace ? 8 : 6);
  if (pinErr) return void res.status(400).json({ error: pinErr });
  if (pinTaken(pin)) {
    return void res.status(400).json({ error: 'PIN sudah dipakai' });
  }
  if (!noFace && !validDescriptors(descriptors)) return void res.status(400).json({ error: 'wajah invalid (burst dulu)' });
  let id = slugify(clean);
  for (let n = 2; db.select().from(members).where(eq(members.id, id)).all()[0]; n++) id = `${slugify(clean)}-${n}`;
  // TIDAK ADA foto wajah disimpan — cuma embedding (dienkripsi di bawah).
  // Kalau member mau avatar, upload foto profil TERPISAH via /api/members/:id/foto
  // (bukan dari proses scan biometrik ini).
  const count = db.select().from(members).all().length;
  db.insert(members).values({
    id, nama: clean, warna: PALETTE[count % PALETTE.length], divisi: 'acara',
    foto: null, angkatan: year, jabatan: jab, pinHash: hashPin(pin), noFaceConsent: noFace ? 1 : 0,
  }).run();
  if (!noFace) db.insert(faces).values({ memberId: id, descriptors: encryptJson(descriptors), updatedAt: Date.now() }).run();
  res.json({ ok: true, memberId: id, nama: clean });
});

// Foto profil OPSIONAL (avatar tampilan), terpisah total dari data biometrik
// wajah. Member cuma bisa ganti fotonya sendiri (tidak perlu PIN admin).
app.put('/api/members/:id/foto', (req, res) => {
  const { id } = req.params;
  const { foto } = (req.body ?? {}) as { foto: string };
  const member = db.select().from(members).where(eq(members.id, id)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  if (!foto) {
    // Kosongkan avatar (kembali ke dot warna). Hapus dua ekstensi (legacy .jpg).
    for (const ext of ['webp', 'jpg']) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, 'profil', `${id}.${ext}`)); } catch { /* abaikan */ }
    }
    db.update(members).set({ foto: null }).where(eq(members.id, id)).run();
    return void res.json({ ok: true, foto: null });
  }
  const saved = saveDataUrl(foto, path.join(UPLOAD_DIR, 'profil', `${id}.webp`));
  if (!saved) return void res.status(400).json({ error: 'foto invalid' });
  const url = `/uploads/profil/${id}.webp`;
  db.update(members).set({ foto: url }).where(eq(members.id, id)).run();
  res.json({ ok: true, foto: url });
});

// ---- PIN login (alternatif wajah; absensi/check-in TETAP wajah) ----
app.post('/api/login/pin', rateLimit(10, 60_000), (req, res) => {
  const { pin } = (req.body ?? {}) as { pin: string };
  if (!/^\d{6,}$/.test(pin ?? '')) return void res.status(400).json({ error: 'PIN minimal 6 digit' });
  const m = findByPin(pin);
  if (!m) return void res.status(401).json({ error: 'PIN salah' });
  // PIN benar = bukti identitas yg cukup utk token atestasi hari ini.
  const tanggal = todayLocal();
  const attest = issueAttest(m.id, tanggal);
  res.json({ ok: true, memberId: m.id, nama: m.nama, attest, tanggal });
});

// Atur/ganti PIN sendiri (sudah login = sudah verifikasi wajah).
app.post('/api/pin/set', (req, res) => {
  const { memberId, pin } = (req.body ?? {}) as { memberId: string; pin: string };
  const member = db.select().from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  const err = pinError(pin, member.angkatan ?? '', member.noFaceConsent ? 8 : 6);
  if (err) return void res.status(400).json({ error: err });
  const taken = pinTaken(pin, memberId);
  if (taken) return void res.status(400).json({ error: 'PIN sudah dipakai' });
  db.update(members).set({ pinHash: hashPin(pin) }).where(eq(members.id, memberId)).run();
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
    tx.delete(attestIssued).where(eq(attestIssued.memberId, id)).run();
    tx.delete(lapsit).where(eq(lapsit.memberId, id)).run();
    tx.delete(attendance).where(eq(attendance.memberId, id)).run();
    tx.delete(evidence).where(eq(evidence.memberId, id)).run();
    tx.delete(faces).where(eq(faces.memberId, id)).run();
    tx.delete(roster).where(eq(roster.memberId, id)).run();
    tx.delete(tasks).where(eq(tasks.memberId, id)).run();
    tx.delete(members).where(eq(members.id, id)).run();
  });
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR, { recursive: true }) as string[]) {
      const base = path.basename(f);
      const stem = base.replace(/\.(jpg|jpeg|png|webp)$/i, '');
      if (stem === id || stem.includes(`_${id}_`)) fs.unlinkSync(path.join(UPLOAD_DIR, f));
    }
  } catch { /* best effort */ }
  res.json({ ok: true });
});
// Endpoint publik LAMA (GET /api/faces) DIHAPUS — dulu mengekspos raw
// embedding SEMUA anggota ke siapa pun tanpa auth, dan matching dilakukan di
// browser (bisa dimanipulasi). Sekarang: matching cuma lewat endpoint ini,
// descriptor tidak pernah keluar dari server.
app.post('/api/faces/match', rateLimit(30, 60_000), (req, res) => {
  const { descriptor } = (req.body ?? {}) as { descriptor: unknown };
  if (!Array.isArray(descriptor) || descriptor.length !== 128
    || !descriptor.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    return void res.status(400).json({ error: 'descriptor invalid' });
  }
  const rows = db.select().from(faces).all();
  const enrolled: Enrolled[] = [];
  for (const r of rows) {
    try {
      enrolled.push({ memberId: r.memberId, descriptors: decryptJson<number[][]>(r.descriptors) });
    } catch (e) {
      console.warn(`face row ${r.memberId} gagal didekripsi (key salah / data korup), dilewati:`, (e as Error).message);
    }
  }
  const hit = identifyFace(descriptor as number[], enrolled);
  if (!hit) return void res.json({ hit: null });
  // Match lolos → terbitkan token atestasi hari ini (dipakai absen/evidence/lapsit).
  const tanggal = todayLocal();
  const attest = issueAttest(hit.memberId, tanggal);
  res.json({ hit, attest, tanggal });
});

// Admin-only: jumlah wajah terdaftar per anggota (buat dashboard), TANPA
// pernah mengirim vektor embedding-nya ke client.
app.get('/api/faces/summary', requireAdmin, (_req, res) => {
  const rows = db.select().from(faces).all();
  res.json(rows.map((r) => ({
    memberId: r.memberId,
    count: decryptJson<number[][]>(r.descriptors).length,
    updatedAt: r.updatedAt,
  })));
});

app.post('/api/faces', requireAdmin, (req, res) => {
  const { memberId, descriptors } = (req.body ?? {}) as { memberId: string; descriptors: unknown };
  const member = db.select().from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  const valid = Array.isArray(descriptors) && descriptors.length >= 1 && descriptors.length <= 3
    && descriptors.every((d) => Array.isArray(d) && d.length === 128
      && (d as unknown[]).every((x) => typeof x === 'number' && Number.isFinite(x)));
  if (!valid) return void res.status(400).json({ error: 'descriptors invalid (1-3 x 128 angka)' });
  const enc = encryptJson(descriptors);
  const existing = db.select().from(faces).where(eq(faces.memberId, memberId)).all()[0];
  if (existing) {
    db.update(faces).set({ descriptors: enc, updatedAt: Date.now() })
      .where(eq(faces.memberId, memberId)).run();
  } else {
    db.insert(faces).values({ memberId, descriptors: enc, updatedAt: Date.now() }).run();
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
  const day = DAYS[dow - 1];
  const rows = effectiveRosterDay(day, mondayOf(tanggal));
  return rows.some((r) => r.memberId === memberId) ? memberId : null;
};

// Senin dari minggu yang memuat `tanggal` (YYYY-MM-DD).
const mondayOf = (tanggal: string): string => {
  const d = new Date(tanggal + 'T00:00');
  const dow = d.getDay(); // 0=Minggu
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Roster EFEKTIF 1 hari: override minggu tsb kalau ada, fallback template.
// SEMUA gate piket (absen/evidence/lapsit/nilai/leaderboard) wajib lewat sini.
const effectiveRosterDay = (day: string, week: string) => {
  const eff = db.select().from(roster)
    .where(and(eq(roster.weekStart, week), eq(roster.day, day))).all();
  return eff.length
    ? eff
    : db.select().from(roster).where(and(isNull(roster.weekStart), eq(roster.day, day))).all();
};

// Jam selesai piket EFEKTIF utk member+tanggal (dipakai gate kirim lapsit).
// Ikuti jam yang diatur admin: pakai override minggu itu kalau ada (hasil
// drag-drop tab Mingguan), fallback ke jadwal template dasar.
const jamSelesaiAt = (tanggal: string, memberId: string): string | null => {
  const dow = new Date(tanggal + 'T00:00').getDay();
  if (dow < 1 || dow > 5) return null;
  const day = DAYS[dow - 1];
  const week = mondayOf(tanggal);
  const overrideRow = db.select().from(roster)
    .where(and(eq(roster.weekStart, week), eq(roster.day, day), eq(roster.memberId, memberId))).all()[0];
  if (overrideRow) return overrideRow.jamSelesai;
  const baseRow = db.select().from(roster)
    .where(and(isNull(roster.weekStart), eq(roster.day, day), eq(roster.memberId, memberId))).all()[0];
  return baseRow?.jamSelesai ?? null;
};

app.post('/api/attendance', (req, res) => {
  const { tanggal, memberId, selfie, attest } = (req.body ?? {}) as { tanggal: string; memberId: string; selfie?: string; attest?: string };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal ?? '')) return void res.status(400).json({ error: 'tanggal invalid' });
  const member = db.select().from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  if (!onDutyAt(tanggal, memberId)) return void res.status(400).json({ error: `${member.nama} tidak piket di tanggal itu` });
  // Bukti identitas: token atestasi wajah/PIN hari ini — kecuali akun
  // PIN-only yg wajib menyertakan selfie terenkripsi sebagai pengganti.
  const selfieOk = member.noFaceConsent && selfie && /^data:image\/webp;base64,/.test(selfie);
  if (!checkAttest(attest, memberId, tanggal) && !selfieOk) {
    return void res.status(403).json({ error: 'verifikasi wajah dulu hari ini' });
  }
  const already = db.select().from(attendance).all()
    .some((r) => r.tanggal === tanggal && r.memberId === memberId);
  if (already) return void res.json({ ok: true, already: true });
  // Member yang menolak scan wajah (PIN-only) WAJIB selfie sbg bukti hadir
  // pengganti face-match. Selfie dienkripsi AES-256-GCM at rest — dipakai
  // sebagai bukti rekap admin, BUKAN utk matching algoritma apa pun.
  if (member.noFaceConsent) {
    if (!selfie || !/^data:image\/webp;base64,/.test(selfie)) {
      return void res.status(400).json({ error: 'selfie wajib untuk akun tanpa wajah (PIN-only)' });
    }
  }
  const now = new Date();
  const jam = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`;
  const selfieEnc = member.noFaceConsent && selfie ? encryptJson(selfie) : null;
  db.insert(attendance).values({ tanggal, memberId, jam, createdAt: Date.now(), selfieEnc }).run();
  // Sinkron ke tabel kehadiran (tidak menimpa izin/sakit/alpa yang sudah ada).
  const kh = db.select().from(kehadiran).where(eq(kehadiran.tanggal, tanggal)).all()
    .find((k) => k.memberId === memberId);
  if (!kh) {
    db.insert(kehadiran).values({ tanggal, memberId, status: 'hadir', acc: null, by: memberId, at: Date.now() }).run();
  }
  res.json({ ok: true, jam });
});

// Selfie absen (terenkripsi) — HANYA admin/superadmin boleh minta lihat.
app.get('/api/attendance/:id/selfie', requireAdmin, (req, res) => {
  const row = db.select().from(attendance).where(eq(attendance.id, Number(req.params.id))).all()[0];
  if (!row?.selfieEnc) return void res.status(404).json({ error: 'tidak ada selfie' });
  try {
    const dataUrl = decryptJson<string>(row.selfieEnc);
    res.json({ selfie: dataUrl });
  } catch {
    res.status(500).json({ error: 'gagal dekripsi' });
  }
});

// ---- bukti per tugas PER ORANG (tiap anggota upload fotonya sendiri) ----
// Privasi: user biasa hanya bisa lihat foto miliknya sendiri (memberId wajib
// & dipaksa cocok dgn query). Admin/superadmin (header x-admin-pin valid)
// boleh lihat foto SIAPA PUN — dipakai di tab Mingguan admin & Superadmin.
app.get('/api/evidence', (req, res) => {
  const { date, from, to, memberId } = req.query as Record<string, string | undefined>;
  const isAdmin = pinEq(req.header('x-admin-pin'), ADMIN_PIN);
  let rows = db.select().from(evidence).all();
  if (date) rows = rows.filter((r) => r.tanggal === date);
  if (from && to) rows = rows.filter((r) => r.tanggal >= from && r.tanggal <= to);
  if (!isAdmin) {
    if (!memberId) return void res.status(400).json({ error: 'memberId wajib (atau PIN Admin untuk lihat semua)' });
    rows = rows.filter((r) => r.memberId === memberId);
  } else if (memberId) {
    rows = rows.filter((r) => r.memberId === memberId); // admin tetap boleh filter 1 orang
  }
  res.json(rows.map((r) => ({ ...r, file: makeSignedEvidenceUrl(`evidence/${r.file}`) })));
});

// Pastikan baris checklist tanggal+member itu ada (clone dari template bila baru).
const ensureChecks = (tanggal: string, memberId: string) => {
  let rows = db.select().from(tasks).where(and(eq(tasks.tanggal, tanggal), eq(tasks.memberId, memberId))).all();
  if (rows.length === 0) {
    const tpl = db.select().from(tasks).where(eq(tasks.tanggal, 'template')).all();
    for (const t of tpl) db.insert(tasks).values({ tanggal, memberId, judul: t.judul, done: 0, sort: t.sort }).run();
    rows = db.select().from(tasks).where(and(eq(tasks.tanggal, tanggal), eq(tasks.memberId, memberId))).all();
  }
  return rows.sort((a, b) => a.sort - b.sort);
};

app.post('/api/evidence', (req, res) => {
  const { tanggal, memberId, tugas, dataUrl, attest } = (req.body ?? {}) as {
    tanggal: string; memberId: string; tugas: string; dataUrl: string; attest?: string;
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal ?? '')) return void res.status(400).json({ error: 'tanggal invalid' });
  const member = db.select().from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  if (!checkAttest(attest, memberId, tanggal)) {
    return void res.status(403).json({ error: 'verifikasi wajah/PIN dulu hari ini' });
  }
  const dow = new Date(tanggal + 'T00:00').getDay();
  const dayName = dow >= 1 && dow <= 5 ? DAYS[dow - 1] : null;
  const onDuty = dayName && onDutyAt(tanggal, memberId);
  if (!onDuty) return void res.status(400).json({ error: `${member.nama} tidak piket di tanggal itu` });
  const task = ensureChecks(tanggal, memberId).find((t) => t.judul === tugas);
  const master = !task
    ? db.select().from(tugasMaster).where(eq(tugasMaster.judul, tugas)).all()[0]
    : null;
  if (!task && !master) return void res.status(400).json({ error: 'foto harus sesuai judul tugas' });
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl ?? '');
  if (!m) return void res.status(400).json({ error: 'foto invalid' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return void res.status(400).json({ error: 'foto >5MB' });
  const slug = tugas.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'foto';
  const fname = task ? `${tanggal}_task${task.id}_${memberId}.webp` : `${tanggal}_${slug}_${memberId}.webp`;
  const existing = db.select().from(evidence).all()
    .find((r) => r.tanggal === tanggal && r.tugas === tugas && r.memberId === memberId);
  if (existing) {
    return void res.status(400).json({ error: 'foto sudah diterima, tidak perlu 2x' });
  }
  fs.mkdirSync(path.join(UPLOAD_DIR, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, 'evidence', fname), buf);
  const file = fname; // path relatif disimpan di DB — URL akses selalu di-generate ulang (signed, expired)
  db.insert(evidence).values({ tanggal, tugas, memberId, file, createdAt: Date.now() }).run();
  if (task) db.update(tasks).set({ done: 1 }).where(eq(tasks.id, task.id)).run(); // upload = selesai
  res.json({ ok: true, file: makeSignedEvidenceUrl(`evidence/${fname}`) });
});

// ---- lapsit akhir piket PER ORANG (wajib foto SENDIRI lengkap dulu) ----
// Privasi: user biasa hanya lihat lapsit miliknya sendiri; admin (x-admin-pin)
// boleh lihat semua — sama seperti evidence.
app.get('/api/lapsit', (req, res) => {
  const { date, from, to, memberId } = req.query as Record<string, string | undefined>;
  const isAdmin = pinEq(req.header('x-admin-pin'), ADMIN_PIN);
  let rows = db.select().from(lapsit).all();
  if (date) rows = rows.filter((r) => r.tanggal === date);
  if (from && to) rows = rows.filter((r) => r.tanggal >= from && r.tanggal <= to);
  if (!isAdmin) {
    if (!memberId) return void res.status(400).json({ error: 'memberId wajib (atau PIN Admin untuk lihat semua)' });
    rows = rows.filter((r) => r.memberId === memberId);
  } else if (memberId) {
    rows = rows.filter((r) => r.memberId === memberId);
  }
  res.json(rows.sort((a, b) => b.createdAt - a.createdAt));
});

app.post('/api/lapsit', (req, res) => {
  const { tanggal, memberId, catatan, lat, lng, acc, attest } = (req.body ?? {}) as {
    tanggal: string; memberId: string; catatan: string;
    lat?: string | null; lng?: string | null; acc?: number | null; attest?: string;
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal ?? '')) return void res.status(400).json({ error: 'tanggal invalid' });
  const member = db.select().from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  if (!checkAttest(attest, memberId, tanggal)) {
    return void res.status(403).json({ error: 'verifikasi wajah/PIN dulu hari ini' });
  }
  if (!onDutyAt(tanggal, memberId)) return void res.status(400).json({ error: `${member.nama} tidak piket di tanggal itu` });
  // Lapsit cuma boleh dikirim maks 30 menit SEBELUM jam selesai piket
  // (jam diatur admin di jadwal, ikut override minggu berjalan kalau ada).
  // Cek hanya berlaku utk tanggal HARI INI — laporan tanggal lampau (yg
  // realistis cuma dari sisi admin melihat histori) tidak perlu digate.
  if (tanggal === todayLocal()) {
    const selesai = jamSelesaiAt(tanggal, memberId);
    if (selesai) {
      const [hh, mm] = selesai.split('.').map(Number);
      const batas = new Date();
      batas.setHours(hh, mm - 30, 0, 0);
      if (new Date() < batas) {
        return void res.status(400).json({
          error: `lapsit baru bisa dikirim mulai 30 menit sebelum piket selesai (${selesai})`,
        });
      }
    }
  }
  const note = (catatan ?? '').trim().replace(/\s+/g, ' ').slice(0, 500);
  if (note.length < 5) return void res.status(400).json({ error: 'catatan minimal 5 huruf' });
  const need = db.select().from(tasks).where(eq(tasks.tanggal, 'template')).all().length;
  // Syarat: foto WAJIB milik anggota INI sendiri lengkap — bukan gabungan tim.
  const got = new Set(
    db.select().from(evidence).where(and(eq(evidence.tanggal, tanggal), eq(evidence.memberId, memberId))).all()
      .map((e) => e.tugas),
  ).size;
  if (got < need) return void res.status(400).json({ error: `lengkapi ${need} foto bukti kamu dulu (baru ${got})` });
  const already = db.select().from(lapsit).where(and(eq(lapsit.tanggal, tanggal), eq(lapsit.memberId, memberId))).all()[0];
  if (already) return void res.status(400).json({ error: 'lapsit kamu hari ini sudah dikirim' });
  const row = db.insert(lapsit).values({
    tanggal, memberId, catatan: note,
    lat: lat ?? null, lng: lng ?? null,
    acc: typeof acc === 'number' ? Math.round(acc) : null,
    createdAt: Date.now(),
  }).run();
  res.json({ ok: true, id: Number(row.lastInsertRowid) });
});

// ---- Rincian Tugas (Opsional): checklist 34 item, PER ORANG ----
// Total item HARUS sinkron dgn src/breakdown.ts (BREAKDOWN) di client.
const BREAKDOWN_TOTAL = 34;

app.get('/api/breakdown', (req, res) => {
  const { date, memberId } = req.query as Record<string, string | undefined>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !memberId) {
    return void res.status(400).json({ error: 'date & memberId wajib' });
  }
  const rows = db.select().from(breakdown)
    .where(and(eq(breakdown.tanggal, date), eq(breakdown.memberId, memberId))).all();
  res.json({ done: rows.map((r) => r.itemKey) });
});

app.post('/api/breakdown', (req, res) => {
  const { tanggal, memberId, itemKey, done } = (req.body ?? {}) as {
    tanggal: string; memberId: string; itemKey: string; done: boolean;
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal ?? '')) return void res.status(400).json({ error: 'tanggal invalid' });
  const member = db.select({ id: members.id }).from(members).where(eq(members.id, memberId)).all()[0];
  if (!member) return void res.status(400).json({ error: 'anggota invalid' });
  if (!/^\d+:\d+$/.test(itemKey ?? '')) return void res.status(400).json({ error: 'itemKey invalid' });
  const existing = db.select().from(breakdown)
    .where(and(eq(breakdown.tanggal, tanggal), eq(breakdown.memberId, memberId), eq(breakdown.itemKey, itemKey))).all()[0];
  if (done) {
    if (!existing) db.insert(breakdown).values({ tanggal, memberId, itemKey, doneAt: Date.now() }).run();
  } else if (existing) {
    db.delete(breakdown).where(eq(breakdown.id, existing.id)).run();
  }
  res.json({ ok: true });
});

// ---- Nilai OTOMATIS real-time: 4 foto wajib (60%) + checklist opsional
// 34 item (30%) + lapsit terkirim (10%). TIDAK ADA verifikasi manual —
// begitu syarat terpenuhi, nilai langsung terhitung & masuk leaderboard.
const nilaiOtomatis = (tanggal: string, memberId: string): number => {
  const needFoto = db.select().from(tasks).where(eq(tasks.tanggal, 'template')).all().length || 1;
  const gotFoto = new Set(
    db.select().from(evidence).where(and(eq(evidence.tanggal, tanggal), eq(evidence.memberId, memberId))).all()
      .map((e) => e.tugas),
  ).size;
  const gotBd = db.select().from(breakdown)
    .where(and(eq(breakdown.tanggal, tanggal), eq(breakdown.memberId, memberId))).all().length;
  const gotLapsit = db.select().from(lapsit)
    .where(and(eq(lapsit.tanggal, tanggal), eq(lapsit.memberId, memberId))).all().length > 0;
  const fotoScore = Math.min(1, gotFoto / needFoto) * 60;
  const bdScore = Math.min(1, gotBd / BREAKDOWN_TOTAL) * 30;
  const lapsitScore = gotLapsit ? 10 : 0;
  return Math.round((fotoScore + bdScore + lapsitScore) * 100) / 100;
};

// Rekap leaderboard real-time (ganti /api/nilai/rekap lama yg butuh verifikasi
// manual ketua/wakil — server yg gak pernah dipakai UI-nya). Dihitung dari
// SEMUA member yg piket di rentang tanggal, bukan cuma yg punya assessment.
app.get('/api/nilai/leaderboard', (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : todayLocal();
  const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : todayLocal();
  const allMembers = db.select().from(members).all();
  const by: Record<string, { nama: string; vals: number[] }> = {};
  let d = new Date(f + 'T00:00');
  const end = new Date(t + 'T00:00');
  while (d <= end) {
    const tanggal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) {
      const day = DAYS[dow - 1];
      const week = mondayOf(tanggal);
      const crew = new Set(effectiveRosterDay(day, week).map((r) => r.memberId));
      for (const mid of crew) {
        const m = allMembers.find((x) => x.id === mid);
        const e = (by[mid] ??= { nama: m?.nama ?? mid, vals: [] });
        e.vals.push(nilaiOtomatis(tanggal, mid));
      }
    }
    d.setDate(d.getDate() + 1);
  }
  const rows = Object.entries(by)
    .map(([memberId, v]) => ({
      memberId, nama: v.nama, n: v.vals.length,
      rata2: v.vals.length ? Math.round((v.vals.reduce((a, n) => a + n, 0) / v.vals.length) * 100) / 100 : null,
    }))
    .sort((a, b) => (b.rata2 ?? -1) - (a.rata2 ?? -1));
  res.json({ rows });
});

// Nilai hari ini utk 1 member (dipakai kartu "Nilai Piketmu" di HP).
app.get('/api/nilai/today', (req, res) => {
  const { date, memberId } = req.query as Record<string, string | undefined>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !memberId) {
    return void res.status(400).json({ error: 'date & memberId wajib' });
  }
  res.json({ nilai: nilaiOtomatis(date, memberId) });
});

// ================= PENILAIAN PER ORANG (LEGACY — belum ada UI, disimpan cadangan) =================
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
      const ada = db.select().from(evidence).where(and(eq(evidence.tanggal, a.tanggal), eq(evidence.memberId, a.memberId))).all()
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
      const ada = db.select().from(evidence).where(and(eq(evidence.tanggal, a.tanggal), eq(evidence.memberId, a.memberId))).all()
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

// ---- pengingat H-1 (jam 19:00) ke yg piket besok ----
// Jalan in-process tiap menit; di serverless TIDAK jalan — produksi pakai
// cron eksternal yg hit POST /api/cron/reminder (super PIN).
const runH1Reminder = async (forceDate?: string): Promise<{ sent: number; tanggal: string }> => {
  const t = new Date();
  const today = forceDate ?? `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  const tm = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
  const tanggal = `${tm.getFullYear()}-${String(tm.getMonth() + 1).padStart(2, '0')}-${String(tm.getDate()).padStart(2, '0')}`;
  const sentKey = `reminder_sent_${today}`;
  const already = db.select().from(settings).where(eq(settings.key, sentKey)).all()[0];
  if (already && !forceDate) return { sent: 0, tanggal };
  const dow = tm.getDay();
  if (dow >= 1 && dow <= 5) {
    const day = DAYS[dow - 1];
    const week = mondayOf(tanggal);
    const crew = effectiveRosterDay(day, week);
    for (const r of crew) {
      const m = db.select().from(members).where(eq(members.id, r.memberId)).all()[0];
      if (!m) continue;
      await sendPush(
        r.memberId, 'Besok giliran piket',
        `${m.nama}, besok (${day}) piket ${r.jamMulai}–${r.jamSelesai}. Jangan lupa!`, '/',
      );
    }
    if (crew.length && !already) {
      db.insert(settings).values({ key: sentKey, value: tanggal }).run();
    }
    // Bersih-bersih penanda lama.
    for (const s of db.select().from(settings).all()) {
      if (s.key.startsWith('reminder_sent_') && s.key !== sentKey) {
        db.delete(settings).where(eq(settings.key, s.key)).run();
      }
    }
    return { sent: crew.length, tanggal };
  }
  return { sent: 0, tanggal };
};

app.post('/api/cron/reminder', requireSuper, async (req, res) => {
  const { force } = (req.body ?? {}) as { force?: boolean };
  const r = await runH1Reminder(force ? todayLocal() : undefined);
  res.json({ ok: true, ...r });
});

setInterval(() => {
  try {
    const t = new Date();
    if (t.getHours() === 19 && t.getMinutes() < 5) void runH1Reminder();
  } catch (e) {
    console.warn('H-1 scheduler error:', (e as Error).message);
  }
}, 60_000);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => console.log(`piket-menwa API :${port} (db=${process.env.DB_FILE ?? './dev.db'})`));