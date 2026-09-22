import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Award, Briefcase, ClipboardList, FileText, Fingerprint, Flag, Medal, PenLine, Shield, Sprout, Users } from 'lucide-react';
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
    .min(5, 'Nama minimal 5 huruf')
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
  pin: z
    .string()
    .regex(/^\d{6,}$/, 'PIN minimal 6 digit angka')
    .refine((p) => !/^(\d)\1+$/.test(p), { message: 'PIN tidak boleh angka sama semua' })
    .refine(
      (p) => {
        const asc = '01234567890123456789';
        const desc = '98765432109876543210';
        for (let i = 0; i + 6 <= p.length; i++) {
          const s = p.slice(i, i + 6);
          if (asc.includes(s) || desc.includes(s)) return false;
        }
        return true;
      },
      { message: 'PIN tidak boleh berurutan' },
    ),
}).refine((v) => !v.pin.includes(v.angkatan), {
  message: 'PIN tidak boleh mengandung tahun angkatan',
  path: ['pin'],
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
  // Slot logo: taruh file di public/brand/logo-menwa.png → otomatis kepakai.
  // Belum ada file = fallback ikon Shield.
  const [logoOk, setLogoOk] = useState(true);
  // Fingerprint FAKE: tahan 1 detik → popup scanning → face login.
  const [holding, setHolding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const timer = useRef<number | null>(null);
  const R = 44;
  const CIRC = 2 * Math.PI * R;
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  const start = () => {
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHolding(false);
      try { navigator.vibrate?.(20); } catch { /* abaikan */ }
      setScanning(true);
      window.setTimeout(() => {
        setScanning(false);
        onTap();
      }, 900);
    }, 1000);
  };
  const cancel = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  return (
    <motion.div
      className="welcome"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
    >
      <motion.div
        className="wlogo"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        {logoOk
          ? <img src="/brand/logo-menwa.png" alt="Logo Menwa" onError={() => setLogoOk(false)} />
          : <Shield size={52} />}
      </motion.div>
      <motion.h1
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.08 }}
      >
        JURNAL PIKET MENWA USB YPKP TAHUN 2026
      </motion.h1>
      <motion.p
        className="wsub"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.16 }}
      >
        Absensi, Jadwal Piket, Bukti Tugas.
      </motion.p>
      <motion.div
        className="fpwrap"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.24 }}
      >
        <button
          className="fphold"
          onPointerDown={start}
          onPointerUp={cancel}
          onPointerLeave={cancel}
          onContextMenu={(e) => e.preventDefault()}
        >
          <svg className="ring" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r={R} className="track" />
            <motion.circle
              cx="50" cy="50" r={R} className="prog"
              strokeDasharray={CIRC}
              initial={{ strokeDashoffset: CIRC }}
              animate={{ strokeDashoffset: holding ? 0 : CIRC }}
              transition={{ duration: holding ? 1 : 0.25, ease: 'linear' }}
            />
          </svg>
          <motion.span animate={{ scale: holding ? 1.08 : 1 }} transition={{ duration: 0.2 }}>
            <Fingerprint size={44} />
          </motion.span>
        </button>
        <p className="whint">tahan 1 detik untuk masuk</p>
      </motion.div>
      <AnimatePresence>
        {scanning && (
          <motion.div
            className="preview" onClick={() => setScanning(false)}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="pvcard scanpop"
              initial={{ opacity: 0, scale: 0.94, y: 14 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
            >
              <span className="spin big" />
              <b>Memindai wajah…</b>
              <span className="hint">hadapkan wajah ke kamera</span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <motion.p
        className="whint"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35, delay: 0.32 }}
      >
        Belum punya akun? <button className="wlink" onClick={onRegister}>Daftar</button>
      </motion.p>
    </motion.div>
  );
}

const stepSchemas = [
  z.object({ nama: profileSchema.shape.nama }),
  z.object({ angkatan: profileSchema.shape.angkatan }),
  z.object({ jabatan: profileSchema.shape.jabatan }),
  z.object({ pin: profileSchema.shape.pin }),
];
const STEP_LABELS = ['Nama', 'Angkatan', 'Jabatan', 'PIN'];

export function ProfilePage({ onDone, onCancel, names, existing }: {
  onDone: (p: Profile) => void; onCancel: () => void; names: string[];
  existing: { nama: string; angkatan: string | null }[];
}) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [nama, setNama] = useState('');
  const [angkatan, setAngkatan] = useState(() => String(new Date().getFullYear()));
  const [jabPreset, setJabPreset] = useState('');
  const [jabCustom, setJabCustom] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // Placeholder animasi dari nama pendaftar beneran (bukan hardcode).
  const [phAnim, setPhAnim] = useState('');
  const namesKey = names.join('|');
  useEffect(() => {
    if (nama || names.length === 0) return;
    const EXAMPLES = names;
    let li = 0;
    let ci = 0;
    let del = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const word = EXAMPLES[li % EXAMPLES.length];
      if (!del) {
        ci += 1;
        setPhAnim(word.slice(0, ci));
        if (ci >= word.length) {
          del = true;
          timer = setTimeout(tick, 1200);
          return;
        }
        timer = setTimeout(tick, 90);
      } else {
        ci -= 1;
        setPhAnim(word.slice(0, ci));
        if (ci <= 0) {
          del = false;
          li += 1;
          timer = setTimeout(tick, 400);
          return;
        }
        timer = setTimeout(tick, 40);
      }
    };
    timer = setTimeout(tick, 500);
    return () => clearTimeout(timer);
  }, [nama, namesKey]);

  const jab = jabPreset === '__custom' ? jabCustom : jabPreset;
  const vals = [{ nama }, { angkatan }, { jabatan: jab }, { pin }];

  // Nama + angkatan yang sama = kemungkinan akun sudah ada.
  const norm = (s: string) => s.trim().toLowerCase();
  const dupe = nama.trim() !== '' && angkatan !== '' && existing.some(
    (e) => norm(e.nama) === norm(nama) && (e.angkatan ?? '') === angkatan,
  );

  const go = (d: number) => {
    const ns = step + d;
    if (ns < 0 || ns > 3) return;
    if (d > 0) {
      if (step === 2 && !jab) {
        setErr('Pilih jabatan atau isi manual.');
        return;
      }
      const payload = step === 3 ? { nama, angkatan, jabatan: jab, pin } : vals[step];
      const schema = step === 3 ? profileSchema : stepSchemas[step];
      const r = schema.safeParse(payload);
      if (!r.success) {
        setErr(r.error.issues[0]?.message ?? 'Isian belum valid.');
        return;
      }
    }
    setErr(null);
    setDir(d);
    setStep(ns);
  };

  const submit = () => {
    if (!jab) {
      setErr('Pilih jabatan atau isi manual.');
      return;
    }
    const r = profileSchema.safeParse({ nama, angkatan, jabatan: jab, pin });
    if (!r.success) {
      setErr(r.error.issues[0]?.message ?? 'Isian belum valid.');
      return;
    }
    setErr(null);
    onDone(r.data);
  };

  return (
    <motion.div
      className="welcome tac"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
    >
      <div className="pbar">
        {[0, 1, 2, 3].map((i) => (
          <motion.i
            key={i}
            initial={false}
            animate={{ opacity: i <= step ? 1 : 0.25 }}
            transition={{ duration: 0.25 }}
            className={i <= step ? 'on' : ''}
          />
        ))}
      </div>
      <p className="pstep-label">Langkah {step + 1} dari 4 — {STEP_LABELS[step]}</p>
      <AnimatePresence mode="wait" custom={dir}>
        <motion.div
          key={step}
          className="pslide"
          custom={dir}
          initial={{ opacity: 0, x: 48 * dir }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -48 * dir }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          {step === 0 && (
            <label className="wfield">
              <span>Nama lengkap</span>
              <input
                placeholder={nama ? undefined : names.length > 0 ? `contoh: ${phAnim}▌` : 'ketik nama lengkap di sini'}
                value={nama} maxLength={30}
                onChange={(e) => setNama(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') go(1); }}
              />
            </label>
          )}
          {step === 1 && (
            <label className="wfield">
              <span>Angkatan (tahun)</span>
              <YearWheel value={angkatan} onChange={setAngkatan} />
            </label>
          )}
          {step === 2 && (
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
                  onKeyDown={(e) => { if (e.key === 'Enter') go(1); }}
                />
              )}
            </div>
          )}
          {step === 3 && (
            <label className="wfield">
              <span>PIN login (min 6 digit)</span>
              <input
                type="password" inputMode="numeric" maxLength={12}
                placeholder="misal: 482917"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
              <small className="hint">Jangan angka sama semua, berurutan, atau tahun angkatanmu.</small>
            </label>
          )}
        </motion.div>
      </AnimatePresence>
      {err && (
        <motion.em
          key={err}
          className="werr"
          initial={{ x: 0 }}
          animate={{ x: [0, -7, 7, -4, 4, 0] }}
          transition={{ duration: 0.35 }}
        >
          {err}
        </motion.em>
      )}
      {dupe && (
        <div className="dupebox">
          <b>Akun anda sudah terdaftar.</b>
          <span>Nama + angkatan ini sudah ada di sistem. Silakan login.</span>
          <button className="wbtn" onClick={onCancel}>Ke login</button>
        </div>
      )}
      <div className="row">
        {step > 0
          ? <button className="wbtn ghost" onClick={() => go(-1)}>Sebelumnya</button>
          : <button className="wbtn ghost" onClick={onCancel}>TUTUP</button>}
        {step < 3
          ? <button className="wbtn" disabled={dupe} onClick={() => go(1)}>Lanjut</button>
          : <button className="wbtn" disabled={dupe} onClick={submit}>Lanjut scan wajah</button>}
      </div>
    </motion.div>
  );
}
