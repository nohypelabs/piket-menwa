export type DayKey = 'Senin' | 'Selasa' | 'Rabu' | 'Kamis' | 'Jumat';
export const DAYS: DayKey[] = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];

export interface Member {
  id: string;
  nama: string;
  warna: string;
}

export const MEMBERS: Member[] = [
  { id: 'baskara', nama: 'Baskara', warna: '#a78bfa' },
  { id: 'andrian', nama: 'Andrian', warna: '#38bdf8' },
  { id: 'maxwell', nama: 'Maxwell', warna: '#34d399' },
  { id: 'adlan', nama: 'Adlan', warna: '#fbbf24' },
  { id: 'daniel', nama: 'Daniel', warna: '#f87171' },
  { id: 'izni', nama: 'Izni', warna: '#f472b6' },
];

export const memberById = (id: string): Member =>
  MEMBERS.find((m) => m.id === id) ?? { id, nama: id, warna: '#6b7280' };

// Seed awal dari user
export const DEFAULT_SCHEDULE: Record<DayKey, string[]> = {
  Senin: ['baskara', 'andrian'],
  Selasa: ['maxwell', 'adlan'],
  Rabu: ['daniel', 'izni'],
  Kamis: ['adlan', 'baskara'],
  Jumat: ['andrian', 'maxwell'],
};

export const DEFAULT_TASKS = ['Sapu & pel sekret', 'Buang sampah', 'Rapikan inventaris'];

export interface SwapReq {
  id: string;
  requester: string; // member id
  target: string; // member id yg diajak tukar
  fromDay: DayKey;
  toDay: DayKey;
  alasan: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, val: unknown) {
  localStorage.setItem(key, JSON.stringify(val));
}

export function todayKeyID(): DayKey | 'Libur' {
  // 0=Minggu..6=Sabtu ; Senin=1..Jumat=5
  const d = new Date().getDay();
  return d >= 1 && d <= 5 ? DAYS[d - 1] : 'Libur';
}

export function tomorrowKeyID(): DayKey | 'Libur' {
  const d = (new Date().getDay() + 1) % 7;
  return d >= 1 && d <= 5 ? DAYS[d - 1] : 'Libur';
}

export function dateStr(offset = 0): string {
  // Waktu LOKAL (bukan UTC) — offset WIB vs UTC bikin hari geser.
  const t = new Date();
  t.setDate(t.getDate() + offset);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const d = String(t.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
