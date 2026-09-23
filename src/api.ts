// Lapisan data: coba API SQLite dulu, fallback ke localStorage (offline/PWA).
import {
  DEFAULT_SCHEDULE, DEFAULT_TASKS,
  dateStr, load, save, type DayKey,
} from './piket';

export interface Member { id: string; nama: string; warna: string; divisi: string; foto: string | null; angkatan: string | null; jabatan: string | null; lastSeen: number | null }
export interface TaskRow { id: number; tanggal: string; judul: string; done: number; sort: number }
export interface SwapRow {
  id: string; requester: string; target: string;
  fromDay: DayKey; toDay: DayKey; alasan: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'; createdAt: number;
}

interface RosterRow { day: DayKey; memberId: string; jamMulai: string; jamSelesai: string }

async function get<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// Sama seperti get(), tapi ikut kirim PIN Admin (bila ada) — dipakai endpoint
// yang server-nya bedakan privasi user-biasa vs admin (evidence, lapsit).
async function getAuthed<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, {
      headers: getPin() ? { 'x-admin-pin': getPin() as string } : {},
    });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function post(url: string, body?: unknown): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getPin() ? { 'x-admin-pin': getPin() as string } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Sama seperti post(), tapi parse & kembalikan body JSON hasilnya (dipakai
// endpoint yang balikin data, misal hasil match wajah).
async function postJson<T>(url: string, body?: unknown): Promise<T | null> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getPin() ? { 'x-admin-pin': getPin() as string } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ---- web push (langganan notif tukar jadwal) ----
const urlB64ToU8 = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export async function ensurePush(memberId: string): Promise<boolean> {
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    if (Notification.permission !== 'granted') return false;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = (await (await fetch('/api/push/public-key')).json()) as { publicKey: string };
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(publicKey) });
    }
    const r = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId, subscription: sub.toJSON() }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function dropPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* abaikan */ }
}
// ---- superadmin (dev) ----
export const getSuperPin = () => sessionStorage.getItem('super-pin');

export async function verifySuper(pin: string): Promise<boolean | null> {
  try {
    const r = await fetch('/api/super/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!r.ok) return null;
    const { ok } = (await r.json()) as { ok: boolean };
    if (ok) sessionStorage.setItem('super-pin', pin);
    return ok;
  } catch {
    return null;
  }
}

export async function superGet<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path, {
      headers: getSuperPin() ? { 'x-super-pin': getSuperPin() as string } : {},
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export interface Overview {
  members: number; faces: number; roster: number; online: number;
  attToday: number; attTotal: number; evToday: number; lapsitToday: number;
  swapsPending: number;
}

export interface FeedItem {
  t: number; jenis: string; teks: string;
}
// ---- PIN ketua (disimpan per sesi, tidak persisten) ----
export const getPin = () => sessionStorage.getItem('piket-pin');
export const setPin = (pin: string) => sessionStorage.setItem('piket-pin', pin);
export const clearPin = () => sessionStorage.removeItem('piket-pin');

export async function verifyPin(pin: string): Promise<boolean | null> {
  try {
    const r = await fetch('/api/admin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!r.ok) return null;
    const { ok } = (await r.json()) as { ok: boolean };
    if (ok) setPin(pin);
    return ok;
  } catch {
    return null; // offline
  }
}

export interface AppState {
  fromApi: boolean;
  members: Member[];
  schedule: Record<DayKey, string[]>;
  jam: Record<DayKey, string>; // "09.00–15.00"
  swaps: SwapRow[];
  templateLen: number; // jumlah tugas master (dipakai buat hitung X/Y bukti)
}

export async function loadState(): Promise<AppState> {
  const s = await get<{
    members: Member[]; roster: RosterRow[];
    swaps: SwapRow[]; template: TaskRow[];
  }>('/api/state');
  if (s) {
    const schedule = { ...DEFAULT_SCHEDULE } as Record<DayKey, string[]>;
    const jam = {} as Record<DayKey, string>;
    for (const k of Object.keys(schedule) as DayKey[]) schedule[k] = [];
    for (const r of s.roster) {
      schedule[r.day].push(r.memberId);
      jam[r.day] = `${r.jamMulai}–${r.jamSelesai}`;
    }
    save('piket-members', s.members);
    return { fromApi: true, members: s.members, schedule, jam, swaps: s.swaps as SwapRow[], templateLen: s.template.length };
  }
  // offline fallback (anggota = cache terakhir, bisa kosong)
  const schedule = load('piket-schedule', DEFAULT_SCHEDULE);
  const swaps = load<SwapRow[]>('piket-swaps', []);
  return {
    fromApi: false,
    members: load<Member[]>('piket-members', []),
    schedule, jam: Object.fromEntries(Object.keys(schedule).map((d) => [d, '09.00–15.00'])) as Record<DayKey, string>,
    swaps, templateLen: DEFAULT_TASKS.length,
  };
}

export async function loadChecks(date: string, memberId: string): Promise<TaskRow[] | null> {
  const rows = await get<TaskRow[]>(`/api/checks?date=${date}&memberId=${encodeURIComponent(memberId)}`);
  return rows;
}

export function localChecks(date = dateStr(0)): TaskRow[] {
  const done: string[] = load<Record<string, string[]>>('piket-checks', {})[date] ?? [];
  return DEFAULT_TASKS.map((judul, i) => ({
    id: -i - 1, tanggal: date, judul, done: done.includes(judul) ? 1 : 0, sort: i,
  }));
}

export async function toggleCheckRemote(date: string, memberId: string, judul: string): Promise<boolean> {
  return post('/api/checks/toggle', { date, memberId, judul });
}

export function toggleCheckLocal(date: string, judul: string) {
  const all = load<Record<string, string[]>>('piket-checks', {});
  const cur = all[date] ?? [];
  all[date] = cur.includes(judul) ? cur.filter((t) => t !== judul) : [...cur, judul];
  save('piket-checks', all);
}

export async function createSwapRemote(s: Omit<SwapRow, 'id' | 'status' | 'createdAt'>): Promise<boolean> {
  return post('/api/swaps', s);
}

export async function decideSwapRemote(id: string, approve: boolean, by: string): Promise<boolean> {
  return post(`/api/swaps/${id}/decide`, { approve, by });
}

export async function cancelSwapRemote(id: string, by: string): Promise<boolean> {
  return post(`/api/swaps/${id}/cancel`, { by });
}

export async function saveRosterRemote(
  schedule: Record<DayKey, string[]>, jam?: Record<DayKey, string>,
): Promise<boolean> {
  try {
    const roster = Object.entries(schedule).flatMap(([day, ids]) => {
      const [jamMulai, jamSelesai] = (jam?.[day as DayKey] ?? '09.00–15.00').split('–');
      return (ids as string[]).map((memberId) => ({
        day, memberId,
        jamMulai: jamMulai ?? '09.00', jamSelesai: jamSelesai ?? '15.00',
      }));
    });
    const r = await fetch('/api/roster', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(getPin() ? { 'x-admin-pin': getPin() as string } : {}),
      },
      body: JSON.stringify({ roster }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ---- roster per-minggu (drag-drop tab Mingguan: minggu depan/seterusnya) ----
export interface WeekRosterRow { day: DayKey; memberId: string; jamMulai: string; jamSelesai: string }

// weekStart = tanggal Senin minggu ybs (YYYY-MM-DD). Fallback ke template dasar
// bila minggu itu belum pernah di-drag-drop (overridden:false).
export async function loadWeekRoster(
  weekStart: string,
): Promise<{ schedule: Record<DayKey, string[]>; jam: Record<DayKey, string>; overridden: boolean } | null> {
  const s = await get<{ roster: WeekRosterRow[]; overridden: boolean }>(`/api/roster/week?start=${weekStart}`);
  if (!s) return null;
  const schedule = { Senin: [], Selasa: [], Rabu: [], Kamis: [], Jumat: [] } as Record<DayKey, string[]>;
  const jam = {} as Record<DayKey, string>;
  for (const r of s.roster) {
    schedule[r.day].push(r.memberId);
    jam[r.day] = `${r.jamMulai}–${r.jamSelesai}`;
  }
  return { schedule, jam, overridden: s.overridden };
}

// Simpan hasil drag-drop untuk 1 minggu spesifik — tidak mengubah template dasar.
export async function saveWeekRosterRemote(
  weekStart: string, schedule: Record<DayKey, string[]>, jam?: Record<DayKey, string>,
): Promise<boolean> {
  try {
    const roster = Object.entries(schedule).flatMap(([day, ids]) => {
      const [jamMulai, jamSelesai] = (jam?.[day as DayKey] ?? '09.00–15.00').split('–');
      return (ids as string[]).map((memberId) => ({
        day, memberId,
        jamMulai: jamMulai ?? '09.00', jamSelesai: jamSelesai ?? '15.00',
      }));
    });
    const r = await fetch('/api/roster/week', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(getPin() ? { 'x-admin-pin': getPin() as string } : {}),
      },
      body: JSON.stringify({ start: weekStart, roster }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Buang override 1 minggu → minggu itu kembali mengikuti template dasar.
export async function clearWeekRosterRemote(weekStart: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/roster/week?start=${weekStart}`, {
      method: 'DELETE',
      headers: { ...(getPin() ? { 'x-admin-pin': getPin() as string } : {}) },
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ---- wajah & absen ----
// FaceRow lama (raw embedding) TIDAK LAGI diambil di client sama sekali.
// Dashboard admin cukup butuh RINGKASAN (berapa vektor terdaftar per orang),
// bukan vektornya — dipakai Super.tsx.
export interface FaceSummary { memberId: string; count: number; updatedAt: number }

export async function loadFaceSummary(): Promise<FaceSummary[]> {
  return (await getAuthed<FaceSummary[]>('/api/faces/summary')) ?? [];
}

// Cocokkan 1 descriptor (hasil scan kamera device sendiri) ke server —
// server yang simpan & bandingkan SEMUA embedding, client cuma terima hasil
// {memberId, ambiguous}, tidak pernah menerima vektor member lain.
export async function matchFace(descriptor: number[]): Promise<{ memberId: string; ambiguous?: boolean } | null> {
  const r = await postJson<{ hit: { memberId: string; distance: number; ambiguous?: boolean } | null }>(
    '/api/faces/match', { descriptor },
  );
  return r?.hit ?? null;
}

export async function saveFaces(
  memberId: string, descriptors: number[][],
): Promise<{ ok: boolean; forbidden?: boolean }> {
  try {
    const r = await fetch('/api/faces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getPin() ? { 'x-admin-pin': getPin() as string } : {}),
      },
      body: JSON.stringify({ memberId, descriptors }),
    });
    return r.ok ? { ok: true } : { ok: false, forbidden: r.status === 403 };
  } catch {
    return { ok: false };
  }
}

export interface AttRow {
  id: number; tanggal: string; memberId: string; jam: string; createdAt: number;
}

export async function loadAttendance(from: string, to: string): Promise<AttRow[] | null> {
  return get<AttRow[]>(`/api/attendance?from=${from}&to=${to}`);
}

export async function markAttendance(tanggal: string, memberId: string): Promise<boolean> {
  return post('/api/attendance', { tanggal, memberId });
}

// Heartbeat presence (fire-and-forget, tanpa PIN).
export function ping(memberId: string) {
  fetch('/api/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId }),
  }).catch(() => {});
}

// Online bila heartbeat < 90 detik.
export const isOnline = (m: { lastSeen: number | null }) =>
  !!m.lastSeen && Date.now() - m.lastSeen < 90000;

// ---- pendaftaran mandiri (wajah + nama + angkatan + jabatan + PIN), tanpa login ----
// CATATAN PRIVASI: TIDAK ADA parameter foto lagi — cuma embedding wajah yang
// dikirim (server enkripsi & simpan sebagai vektor, bukan gambar). Kalau mau
// avatar profil, upload TERPISAH lewat setProfilePhoto() setelah login.
export async function registerMember(
  nama: string, angkatan: string, jabatan: string, pin: string, descriptors: number[][],
): Promise<{ ok: boolean; memberId?: string; error?: string }> {
  try {
    const r = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nama, angkatan, jabatan, pin, descriptors }),
    });
    const j = (await r.json()) as { memberId?: string; error?: string };
    return r.ok ? { ok: true, memberId: j.memberId } : { ok: false, error: j.error ?? 'gagal' };
  } catch {
    return { ok: false, error: 'offline — butuh online untuk daftar' };
  }
}

// Foto profil OPSIONAL (avatar tampilan) — beda total dari data biometrik
// wajah, hanya foto yang dipilih sendiri oleh member. dataUrl='' = hapus avatar.
export async function setProfilePhoto(memberId: string, dataUrl: string): Promise<{ ok: boolean; foto: string | null; error?: string }> {
  try {
    const r = await fetch(`/api/members/${encodeURIComponent(memberId)}/foto`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foto: dataUrl }),
    });
    const j = (await r.json()) as { foto?: string | null; error?: string };
    return r.ok ? { ok: true, foto: j.foto ?? null } : { ok: false, foto: null, error: j.error ?? 'gagal' };
  } catch {
    return { ok: false, foto: null, error: 'offline' };
  }
}

// ---- login PIN (alternatif wajah) ----
export async function loginPin(pin: string): Promise<{ ok: boolean; memberId?: string; nama?: string; error?: string }> {
  try {
    const r = await fetch('/api/login/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const j = (await r.json()) as { memberId?: string; nama?: string; error?: string };
    return r.ok ? { ok: true, memberId: j.memberId, nama: j.nama } : { ok: false, error: j.error ?? 'gagal' };
  } catch {
    return { ok: false, error: 'offline — butuh online untuk masuk' };
  }
}

export async function setLoginPin(memberId: string, pin: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch('/api/pin/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId, pin }),
    });
    const j = (await r.json()) as { error?: string };
    return r.ok ? { ok: true } : { ok: false, error: j.error ?? 'gagal' };
  } catch {
    return { ok: false, error: 'offline' };
  }
}

export async function deleteMember(id: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/members/${id}`, {
      method: 'DELETE',
      headers: { ...(getSuperPin() ? { 'x-super-pin': getSuperPin() as string } : {}) },
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ---- bukti per tugas ----
export interface EvidenceRow {
  id: number; tanggal: string; tugas: string; memberId: string;
  file: string; createdAt: number;
}

export async function loadEvidence(from: string, to: string, memberId?: string): Promise<EvidenceRow[] | null> {
  const q = memberId ? `&memberId=${encodeURIComponent(memberId)}` : '';
  return getAuthed<EvidenceRow[]>(`/api/evidence?from=${from}&to=${to}${q}`);
}

export async function uploadEvidence(
  tanggal: string, memberId: string, tugas: string, dataUrl: string,
): Promise<{ ok: boolean; file?: string; error?: string }> {
  try {
    const r = await fetch('/api/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tanggal, memberId, tugas, dataUrl }),
    });
    const j = (await r.json()) as { file?: string; error?: string };
    return r.ok ? { ok: true, file: j.file } : { ok: false, error: j.error ?? 'gagal' };
  } catch {
    return { ok: false, error: 'offline — butuh online untuk upload bukti' };
  }
}

// ---- lapsit akhir piket ----
export interface LapsitRow {
  id: number; tanggal: string; memberId: string; catatan: string;
  lat: string | null; lng: string | null; acc: number | null; createdAt: number;
}

export async function loadLapsit(from: string, to: string, memberId?: string): Promise<LapsitRow[] | null> {
  const q = memberId ? `&memberId=${encodeURIComponent(memberId)}` : '';
  return getAuthed<LapsitRow[]>(`/api/lapsit?from=${from}&to=${to}${q}`);
}

export async function submitLapsit(
  tanggal: string, memberId: string, catatan: string, geo: { lat: number; lng: number; acc: number } | null,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch('/api/lapsit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tanggal, memberId, catatan,
        lat: geo ? String(geo.lat) : null,
        lng: geo ? String(geo.lng) : null,
        acc: geo ? geo.acc : null,
      }),
    });
    const j = (await r.json()) as { error?: string };
    return r.ok ? { ok: true } : { ok: false, error: j.error ?? 'gagal' };
  } catch {
    return { ok: false, error: 'offline — butuh online untuk kirim lapsit' };
  }
}

// ---- Rincian Tugas (Opsional): checklist disinkron ke server, per orang ----
export async function loadBreakdown(date: string, memberId: string): Promise<string[]> {
  const r = await getAuthed<{ done: string[] }>(`/api/breakdown?date=${date}&memberId=${encodeURIComponent(memberId)}`);
  return r?.done ?? [];
}

export async function toggleBreakdown(tanggal: string, memberId: string, itemKey: string, done: boolean): Promise<boolean> {
  try {
    const r = await fetch('/api/breakdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tanggal, memberId, itemKey, done }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Nilai piket hari ini (otomatis: foto wajib + checklist opsional + lapsit).
export async function loadNilaiToday(date: string, memberId: string): Promise<number | null> {
  const r = await getAuthed<{ nilai: number }>(`/api/nilai/today?date=${date}&memberId=${encodeURIComponent(memberId)}`);
  return r?.nilai ?? null;
}

export interface LeaderboardRow { memberId: string; nama: string; n: number; rata2: number | null }
export async function loadLeaderboard(from: string, to: string): Promise<LeaderboardRow[]> {
  const r = await getAuthed<{ rows: LeaderboardRow[] }>(`/api/nilai/leaderboard?from=${from}&to=${to}`);
  return r?.rows ?? [];
}

// Kompres foto dari kamera sebelum kirim (hemat kuota & disk).
export function compressImage(file: File, maxDim = 1280, quality = 0.75): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('baca foto gagal')); };
    img.src = url;
  });
}
