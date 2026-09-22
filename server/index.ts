import cors from 'cors';
import { eq } from 'drizzle-orm';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/client.ts';
import { attendance, evidence, faces, lapsit, members, roster, swaps, tasks } from '../db/schema.sqlite.ts';

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
if (!process.env.SUPER_PIN) console.log('⚠️  SUPER_PIN belum diset, pakai default "super123" — ganti via env.');
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

// ---- roster (admin ganti jadwal + jam) ----
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
    tx.delete(roster).run();
    for (const r of rows) {
      tx.insert(roster).values({
        day: r.day, memberId: r.memberId,
        jamMulai: r.jamMulai ?? '09.00', jamSelesai: r.jamSelesai ?? '15.00',
      }).run();
    }
  });
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
  res.json({ ok: true, id });
});

app.post('/api/swaps/:id/decide', requireAdmin, (req, res) => {
  const { approve } = req.body as { approve: boolean };
  const row = db.select().from(swaps).where(eq(swaps.id, req.params.id)).all()[0];
  if (!row) return void res.status(404).json({ error: 'swap tidak ditemukan' });
  if (row.status !== 'pending') return void res.status(400).json({ error: 'sudah diputuskan' });
  db.update(swaps).set({ status: approve ? 'approved' : 'rejected' }).where(eq(swaps.id, row.id)).run();
  if (approve) {
    // tukar 1 orang antar dua hari
    const fromRows = db.select().from(roster).where(eq(roster.day, row.fromDay)).all();
    const toRows = db.select().from(roster).where(eq(roster.day, row.toDay)).all();
    for (const r of fromRows.filter((x) => x.memberId === row.requester)) {
      db.update(roster).set({ memberId: row.target }).where(eq(roster.id, r.id)).run();
    }
    for (const r of toRows.filter((x) => x.memberId === row.target)) {
      db.update(roster).set({ memberId: row.requester }).where(eq(roster.id, r.id)).run();
    }
  }
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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

app.post('/api/register', (req, res) => {
  const { nama, angkatan, jabatan, descriptors, foto } = (req.body ?? {}) as {
    nama: string; angkatan: string; jabatan: string; descriptors: unknown; foto: string;
  };
  const clean = (nama ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
  if (clean.length < 2) return void res.status(400).json({ error: 'nama minimal 2 huruf' });
  const year = (angkatan ?? '').trim();
  const yNum = Number(year);
  if (!/^\d{4}$/.test(year) || yNum < 2000 || yNum > new Date().getFullYear() + 1) {
    return void res.status(400).json({ error: 'angkatan harus tahun 4 digit yang wajar' });
  }
  const jab = (jabatan ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (jab.length < 2) return void res.status(400).json({ error: 'jabatan minimal 2 huruf' });
  if (!validDescriptors(descriptors)) return void res.status(400).json({ error: 'wajah invalid (burst dulu)' });
  let id = slugify(clean);
  for (let n = 2; db.select().from(members).where(eq(members.id, id)).all()[0]; n++) id = `${slugify(clean)}-${n}`;
  const fotoFile = saveDataUrl(foto ?? '', path.join(UPLOAD_DIR, 'faces', `${id}.jpg`));
  if (!fotoFile) return void res.status(400).json({ error: 'foto wajah wajib' });
  const count = db.select().from(members).all().length;
  db.insert(members).values({
    id, nama: clean, warna: PALETTE[count % PALETTE.length], divisi: 'acara',
    foto: `/uploads/faces/${id}.jpg`, angkatan: year, jabatan: jab,
  }).run();
  db.insert(faces).values({ memberId: id, descriptors: JSON.stringify(descriptors), updatedAt: Date.now() }).run();
  res.json({ ok: true, memberId: id, nama: clean });
});

// ---- hapus anggota (Admin): bersih + file ikut dibuang ----
app.delete('/api/members/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  db.transaction((tx) => {
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
  if (!task) return void res.status(400).json({ error: 'foto harus sesuai judul tugas' });
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl ?? '');
  if (!m) return void res.status(400).json({ error: 'foto invalid' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return void res.status(400).json({ error: 'foto >5MB' });
  const fname = `${tanggal}_task${task.id}.jpg`;
  const existing = db.select().from(evidence).all()
    .find((r) => r.tanggal === tanggal && r.tugas === tugas);
  if (existing) {
    return void res.status(400).json({ error: 'foto sudah diterima, tidak perlu 2x' });
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  const file = `/uploads/${fname}`;
  db.insert(evidence).values({ tanggal, tugas, memberId, file, createdAt: Date.now() }).run();
  db.update(tasks).set({ done: 1 }).where(eq(tasks.id, task.id)).run(); // upload = selesai
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

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => console.log(`piket-menwa API :${port} (db=${process.env.DB_FILE ?? './dev.db'})`));
