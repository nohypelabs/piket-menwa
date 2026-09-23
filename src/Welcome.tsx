import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Award, Briefcase, ClipboardList, FileText, Fingerprint, Flag, Lock as LockIcon, Medal, PenLine, ScanFace, Shield, Sprout, Users } from 'lucide-react';
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
  consentWajah: z.boolean(),
  pin: z.string(),
}).superRefine((v, ctx) => {
  const minLen = v.consentWajah ? 6 : 8;
  if (!new RegExp(`^\\d{${minLen},}$`).test(v.pin)) {
    ctx.addIssue({ code: 'custom', path: ['pin'], message: `PIN minimal ${minLen} digit angka` });
    return;
  }
  if (/^(\d)\1+$/.test(v.pin)) {
    ctx.addIssue({ code: 'custom', path: ['pin'], message: 'PIN tidak boleh angka sama semua' });
    return;
  }
  const asc = '01234567890123456789';
  const desc = '98765432109876543210';
  for (let i = 0; i + 6 <= v.pin.length; i++) {
    const s = v.pin.slice(i, i + 6);
    if (asc.includes(s) || desc.includes(s)) {
      ctx.addIssue({ code: 'custom', path: ['pin'], message: 'PIN tidak boleh berurutan' });
      return;
    }
  }
  if (v.pin.includes(v.angkatan)) {
    ctx.addIssue({ code: 'custom', path: ['pin'], message: 'PIN tidak boleh mengandung tahun angkatan' });
  }
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

export function WelcomePage({ onTap, onRegister, onPinLogin }: {
  onTap: () => void; onRegister: () => void;
  onPinLogin: (pin: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  // Slot logo: taruh file di public/brand/logo-menwa.png → otomatis kepakai.
  // Belum ada file = fallback ikon Shield.
  const [logoOk, setLogoOk] = useState(true);
  // Fingerprint FAKE 2 tahap (KEBALIK dari biasa): tahan 1 dtk → PIN,
  // tahan terus sampai 2 dtk → face recognition.
  const [holding, setHolding] = useState(false);
  const [holdStage, setHoldStage] = useState<0 | 1 | 2>(0);
  const [scanning, setScanning] = useState(false);
  const [showPinSheet, setShowPinSheet] = useState(false);
  const [pinIn, setPinIn] = useState('');
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const timers = useRef<number[]>([]);
  const faceFired = useRef(false);
  const t0 = useRef(0);
  const R = 44;
  const CIRC = 2 * Math.PI * R;
  useEffect(() => () => {
    timers.current.forEach((t) => window.clearTimeout(t));
  }, []);
  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  const vib = (p: number | number[]) => {
    try { navigator.vibrate?.(p); } catch { /* abaikan */ }
  };
  const submitPin = async () => {
    setPinBusy(true);
    setPinErr(null);
    const r = await onPinLogin(pinIn);
    setPinBusy(false);
    if (r.ok) {
      setShowPinSheet(false);
      setPinIn('');
    } else {
      setPinErr(r.error ?? 'Gagal masuk.');
    }
  };
  const start = () => {
    setHolding(true);
    setHoldStage(0);
    faceFired.current = false;
    t0.current = Date.now();
    timers.current.push(window.setTimeout(() => {
      // Tahap 1 (1 dtk): buka sheet PIN.
      setHoldStage(1);
      vib(15);
      setPinErr(null);
      setShowPinSheet(true);
    }, 1000));
    timers.current.push(window.setTimeout(() => {
      // Tahap 2 (2 dtk): tutup PIN, alih ke face recognition.
      faceFired.current = true;
      setHolding(false);
      setHoldStage(0);
      vib([20, 40, 30]);
      setShowPinSheet(false);
      setScanning(true);
      window.setTimeout(() => {
        setScanning(false);
        onTap();
      }, 900);
    }, 2000));
  };
  const cancel = () => {
    clearTimers();
    const held = Date.now() - t0.current;
    const fired = faceFired.current;
    faceFired.current = false;
    setHolding(false);
    setHoldStage(0);
    // Sheet PIN sudah dibuka di tahap 1 → biarkan terbuka.
    // Face sudah jalan → biarkan. Tap singkat → batal total.
    if (fired || held < 1000) {
      if (!fired) setShowPinSheet(false);
      return;
    }
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
          {!holding && (
            <>
              <span className="fpping" style={{ animationDelay: '0s' }} />
              <span className="fpping" style={{ animationDelay: '1s' }} />
            </>
          )}
          <svg className="ring" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r={R} className="track" />
            <motion.circle
              cx="50" cy="50" r={R} className="prog"
              strokeDasharray={CIRC}
              initial={{ strokeDashoffset: CIRC }}
              animate={{ strokeDashoffset: holding ? 0 : CIRC }}
              transition={{ duration: holding ? 2 : 0.25, ease: 'linear' }}
            />
          </svg>
          <motion.span animate={{ scale: holding ? 1.08 : 1 }} transition={{ duration: 0.2 }}>
            <Fingerprint size={44} />
          </motion.span>
        </button>
        <p className="whint">
          {holding && holdStage >= 1 ? 'lepas = PIN • tahan terus = wajah' : 'tahan 1 dtk PIN • 2 dtk wajah'}
        </p>
      </motion.div>
      <AnimatePresence>
        {showPinSheet && (
          <motion.div
            className="preview" onClick={() => setShowPinSheet(false)}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="sheet pinsheet-modal" onClick={(e) => e.stopPropagation()}
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'tween', duration: 0.28, ease: 'easeOut' }}
              drag="y" dragConstraints={{ top: 0, bottom: 0 }} dragElastic={0.25}
              onDragEnd={(_, info) => {
                if (info.offset.y > 90 || info.velocity.y > 500) setShowPinSheet(false);
              }}
            >
              <i className="grabber" />
              <b>Masuk via PIN</b>
              <input
                type="password" inputMode="numeric" maxLength={12}
                placeholder="PIN 6 digit" value={pinIn}
                onChange={(e) => setPinIn(e.target.value.replace(/\D/g, '').slice(0, 12))}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitPin(); }}
              />
              {pinErr && <em className="werr">{pinErr}</em>}
              <div className="row">
                <button className="primary" disabled={pinBusy} onClick={submitPin}>
                  {pinBusy ? '…' : 'Masuk'}
                </button>
                <button onClick={() => setShowPinSheet(false)}>Batal</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
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
      <motion.p
        className="wsecure"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35, delay: 0.4 }}
      >
        Foto wajah Anda tidak tersimpan. Hanya embedding yang disimpan dan terenkripsi oleh AES-256-GCM.
      </motion.p>
    </motion.div>
  );
}

const stepSchemas = [
  z.object({ nama: profileSchema.shape.nama }),
  z.object({ angkatan: profileSchema.shape.angkatan }),
  z.object({ jabatan: profileSchema.shape.jabatan }),
];
const STEP_LABELS = ['Nama', 'Angkatan', 'Jabatan', 'Persetujuan Data Wajah', 'PIN'];

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
  const [consentWajah, setConsentWajah] = useState<boolean | null>(null);
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
  const vals = [{ nama }, { angkatan }, { jabatan: jab }];

  // Nama + angkatan yang sama = kemungkinan akun sudah ada.
  const norm = (s: string) => s.trim().toLowerCase();
  const dupe = nama.trim() !== '' && angkatan !== '' && existing.some(
    (e) => norm(e.nama) === norm(nama) && (e.angkatan ?? '') === angkatan,
  );

  const go = (d: number) => {
    const ns = step + d;
    if (ns < 0 || ns > 4) return;
    if (d > 0) {
      if (step === 2 && !jab) {
        setErr('Pilih jabatan atau isi manual.');
        return;
      }
      if (step === 3 && consentWajah === null) {
        setErr('Pilih salah satu opsi persetujuan.');
        return;
      }
      if (step < 3) {
        const r = stepSchemas[step].safeParse(vals[step]);
        if (!r.success) {
          setErr(r.error.issues[0]?.message ?? 'Isian belum valid.');
          return;
        }
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
    if (consentWajah === null) {
      setErr('Pilih salah satu opsi persetujuan.');
      return;
    }
    const r = profileSchema.safeParse({ nama, angkatan, jabatan: jab, consentWajah, pin });
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
        {[0, 1, 2, 3, 4].map((i) => (
          <motion.i
            key={i}
            initial={false}
            animate={{ opacity: i <= step ? 1 : 0.25 }}
            transition={{ duration: 0.25 }}
            className={i <= step ? 'on' : ''}
          />
        ))}
      </div>
      <p className="pstep-label">Langkah {step + 1} dari 5 — {STEP_LABELS[step]}</p>
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
            <div className="wfield consent">
              <span>Persetujuan Pemrosesan Data Wajah</span>
              <p className="hint">
                Sesuai UU No. 27/2022 (Pelindungan Data Pribadi), wajah adalah data pribadi
                spesifik. Kami butuh persetujuan Anda: foto wajah TIDAK disimpan — hanya
                embedding (representasi angka) yang diproses lalu dienkripsi AES-256-GCM,
                dipakai untuk verifikasi absensi piket. Anda bisa menolak dan pakai PIN saja.
              </p>
              <div className="consentgrid">
                <button
                  type="button"
                  className={`jabcard ${consentWajah === true ? 'sel' : ''}`}
                  onClick={() => setConsentWajah(true)}
                >
                  <ScanFace size={16} /> Setuju, pakai wajah untuk absen
                </button>
                <button
                  type="button"
                  className={`jabcard ${consentWajah === false ? 'sel' : ''}`}
                  onClick={() => setConsentWajah(false)}
                >
                  <LockIcon size={16} /> Tidak, pakai PIN saja
                </button>
              </div>
              {consentWajah === false && (
                <p className="hint warn">
                  Absen piket harianmu nanti diinput manual oleh admin (bukan otomatis kamera),
                  karena PIN adalah satu-satunya faktor keamanan akunmu.
                </p>
              )}
            </div>
          )}
          {step === 4 && (
            <label className="wfield">
              <span>PIN login (min {consentWajah ? 6 : 8} digit)</span>
              <input
                type="password" inputMode="numeric" maxLength={12}
                placeholder={consentWajah ? 'misal: 482917' : 'misal: 48291736'}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
              <small className="hint">
                Jangan angka sama semua, berurutan, atau tahun angkatanmu.
                {!consentWajah && ' PIN 8 digit karena ini satu-satunya kunci akunmu.'}
              </small>
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
        {step < 4
          ? <button className="wbtn" disabled={dupe} onClick={() => go(1)}>Lanjut</button>
          : <button className="wbtn" disabled={dupe} onClick={submit}>
              {consentWajah ? 'Lanjut scan wajah' : 'Daftar'}
            </button>}
      </div>
    </motion.div>
  );
}
