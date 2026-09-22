import { useEffect, useMemo, useRef, useState } from 'react';
import { Award, Briefcase, ClipboardList, FileText, Flag, Medal, PenLine, Shield, Sprout, Users } from 'lucide-react';
import { z } from 'zod';

export const JABATAN_LIST = [
  'Danki',
  'Kaur Ops',
  'Staff ops',
  'Kaur Min',
  'Staf min',
  'KaUrdal',
  'Anggota Urdal',
  'Provost',
  'Anggota Remaja',
] as const;

const JABATAN_ICON = [Shield, ClipboardList, FileText, Users, Briefcase, Flag, Award, Medal, Sprout] as const;

export const profileSchema = z.object({
  nama: z
    .string()
    .trim()
    .min(2, 'Nama minimal 2 huruf')
    .max(30, 'Nama maksimal 30 huruf')
    .regex(/^[A-Za-zÀ-ÿ'’.\- ]+$/, 'Nama hanya huruf, spasi, titik, strip'),
  angkatan: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'Angkatan harus 4 digit tahun')
    .refine(
      (y) => {
        const n = Number(y);
        return n >= 2000 && n <= new Date().getFullYear() + 1;
      },
      { message: 'Tahun angkatan tidak wajar' },
    ),
  jabatan: z
    .string()
    .trim()
    .min(2, 'Jabatan minimal 2 huruf')
    .max(40, 'Jabatan maksimal 40 huruf'),
});

export type Profile = z.infer<typeof profileSchema>;

// Wheel picker tahun ala iOS (scroll + snap, tanpa ketik).
export function YearWheel({ value, onChange }: { value: string; onChange: (y: string) => void }) {
  const years = useMemo(() => {
    const arr: string[] = [];
    for (let y = 2000; y <= new Date().getFullYear() + 1; y++) arr.push(String(y));
    return arr;
  }, []);
  const ref = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState(value || String(new Date().getFullYear()));
  const ITEM = 40;
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = Math.max(0, years.indexOf(sel)) * ITEM;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout>;
    const h = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const i = Math.min(Math.max(Math.round(el.scrollTop / ITEM), 0), years.length - 1);
        setSel(years[i]);
        onChange(years[i]);
      }, 120);
    };
    el.addEventListener('scroll', h, { passive: true });
    return () => {
      el.removeEventListener('scroll', h);
      clearTimeout(t);
    };
  }, [years, onChange]);
  const pick = (y: string) => {
    setSel(y);
    onChange(y);
    ref.current?.scrollTo({ top: years.indexOf(y) * ITEM, behavior: 'smooth' });
  };
  return (
    <div className="wheel" ref={ref}>
      <div className="wpad" />
      {years.map((y) => (
        <div key={y} className={y === sel ? 'sel' : ''} onClick={() => pick(y)}>{y}</div>
      ))}
      <div className="wpad" />
    </div>
  );
}

export function WelcomePage({ onTap, onRegister }: { onTap: () => void; onRegister: () => void }) {
  return (
    <div className="welcome">
      <div className="wlogo"><Shield size={56} /></div>
      <h1>Jadwal Piket Menwa USB YPKP</h1>
      <p className="wsub">Absensi wajah • jadwal piket • bukti tugas</p>
      <button className="wbtn" onClick={onTap}>
        Masuk
      </button>
      <p className="whint">Belum punya akun? <button className="wlink" onClick={onRegister}>Daftar</button></p>
    </div>
  );
}

export function ProfilePage({ onDone }: { onDone: (p: Profile) => void }) {
  const [nama, setNama] = useState('');
  const [angkatan, setAngkatan] = useState(() => String(new Date().getFullYear()));
  const [jabPreset, setJabPreset] = useState('');
  const [jabCustom, setJabCustom] = useState('');
  const [errs, setErrs] = useState<{ nama?: string; angkatan?: string; jabatan?: string }>({});

  const submit = () => {
    const jab = jabPreset === '__custom' ? jabCustom : jabPreset;
    if (!jab) {
      setErrs({ jabatan: 'Pilih jabatan atau isi manual.' });
      return;
    }
    const r = profileSchema.safeParse({ nama, angkatan, jabatan: jab });
    if (!r.success) {
      const out: typeof errs = {};
      for (const issue of r.error.issues) {
        const k = issue.path[0] as 'nama' | 'angkatan' | 'jabatan';
        out[k] ??= issue.message;
      }
      setErrs(out);
      return;
    }
    setErrs({});
    onDone(r.data);
  };

  return (
    <div className="welcome">
      <h1>Lengkapi profil</h1>
      <p className="wsub">Wajahmu belum terdaftar — isi sekali saja.</p>
      <label className="wfield">
        <span>Nama lengkap</span>
        <input
          placeholder="cth: Abdul Gofur"
          value={nama} maxLength={30}
          onChange={(e) => setNama(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        {errs.nama && <em className="werr">{errs.nama}</em>}
      </label>
      <label className="wfield">
        <span>Angkatan (tahun)</span>
        <YearWheel value={angkatan} onChange={setAngkatan} />
        {errs.angkatan && <em className="werr">{errs.angkatan}</em>}
      </label>
      <div className="wfield">
        <span>Jabatan di kompi</span>
        <div className="jabgrid">
          {JABATAN_LIST.map((j, i) => {
            const Icon = JABATAN_ICON[i];
            return (
              <button
                key={j} type="button"
                className={`jabcard ${jabPreset === j ? 'sel' : ''}`}
                onClick={() => setJabPreset(j)}
              >
                <Icon size={16} /> {j}
              </button>
            );
          })}
          <button
            type="button"
            className={`jabcard ${jabPreset === '__custom' ? 'sel' : ''}`}
            onClick={() => setJabPreset('__custom')}
          >
            <PenLine size={16} /> Lainnya
          </button>
        </div>
        {jabPreset === '__custom' && (
          <input
            placeholder="cth: Provos" value={jabCustom} maxLength={40}
            onChange={(e) => setJabCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        )}
        {errs.jabatan && <em className="werr">{errs.jabatan}</em>}
      </div>
      <button className="wbtn" onClick={submit}>
        Lanjut scan wajah
      </button>
    </div>
  );
}
