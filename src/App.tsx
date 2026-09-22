import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight, Bell, CalendarDays, CalendarRange, Camera, Check, Clock, Info, Lock,
  LockOpen, LogOut, PartyPopper, Plus, Repeat, RotateCw, ScanFace, Settings,
  TriangleAlert, X,
} from 'lucide-react';
import {
  clearPin, createSwapRemote, decideSwapRemote, deleteMember,
  loadAttendance, loadChecks, loadEvidence, loadFaces, loadLapsit, loadState,
  localChecks, markAttendance, ping, isOnline, registerMember, saveRosterRemote,
  submitLapsit, uploadEvidence, verifyPin,
  type AppState, type AttRow, type EvidenceRow, type FaceRow, type LapsitRow,
  type Member, type SwapRow, type TaskRow,
} from './api';
import { getGeo, stampPhoto, type Geo } from './bukti';
import { BREAKDOWN } from './breakdown';
import { descriptorFromVideo, ensureModels, getFaceApi, identify, photoFromVideo, ting, tingStage, warmAudio, yawFromVideo } from './face';
import { ProfilePage, WelcomePage, profileSchema, type Profile } from './Welcome';
import SuperView from './Super';
import { DAYS, dateStr, load, memberById, save, todayKeyID, tomorrowKeyID, type DayKey } from './piket';

type Tab = 'hari' | 'minggu' | 'tukar';

const fmtTanggal = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
const todayLong = () => {
  const s = fmtTanggal.format(new Date());
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// Modal kamera selfie: sekali-ambil (verifikasi/absen) atau burst (daftar).
function FaceCam({ title, note, enroll, onShot, onEnroll, onClose, onRescan }: {
  title: string; note: string | null; enroll?: boolean;
  onShot: (d: number[]) => void; onEnroll: (ds: number[][], photo: string | null) => void;
  onClose: () => void; onRescan?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const liveRef = useRef(true);
  const [status, setStatus] = useState('menyiapkan kamera…');
  const [failed, setFailed] = useState(false);
  const [tryNo, setTryNo] = useState(0);
  const [modelsReady, setModelsReady] = useState(false);
  const [faceBox, setFaceBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'done' | 'timeout'>('idle');
  const [scanHint, setScanHint] = useState<string | null>(null);
  const stableRef = useRef(0);
  const onShotRef = useRef(onShot);
  onShotRef.current = onShot;
  useEffect(() => {
    liveRef.current = true;
    let stream: MediaStream | null = null;
    let live = true;
    (async () => {
      try {
        setFailed(false);
        if (!navigator.mediaDevices?.getUserMedia) {
          throw Object.assign(new Error('browser tidak mendukung kamera — buka via Chrome + HTTPS'), { name: 'NoSupport' });
        }
        setStatus('meminta izin kamera… (izinkan saat HP bertanya)');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
        if (!live) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        if (!live) return;
        setStatus('kamera OK — memuat model wajah…');
        await ensureModels((m) => { if (live) setStatus('kamera OK — ' + m); });
        if (live) setStatus(enroll ? 'tap Mulai, ikuti 3 tahap (tahan–kanan–kiri)' : 'posisikan wajah di tengah, lalu Ambil');
      } catch (e) {
        if (!live) return;
        const name = (e as Error).name;
        if (name === 'NotAllowedError') {
          setStatus('Izin kamera DITOLAK. Tap ikon gembok di address bar → Camera → Allow, lalu reload. Kalau dibuka dari WA/Telegram, salin link ke Chrome.');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setStatus('Kamera tidak ditemukan di perangkat ini.');
        } else {
          setStatus('gagal: ' + (e as Error).message);
        }
        setFailed(true);
      }
    })();
    return () => { live = false; liveRef.current = false; stream?.getTracks().forEach((t) => t.stop()); };
  }, [enroll, tryNo]);
  // Loop deteksi ringan buat panduan bingkai live (kotak hijau).
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    (async () => {
      try {
        await ensureModels();
        if (!live) return;
        setModelsReady(true);
        const f = await getFaceApi();
        timer = setInterval(async () => {
          const v = videoRef.current;
          if (!v || v.readyState < 2 || v.videoWidth === 0) return;
          try {
            const det = await f.detectSingleFace(v, new f.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }));
            if (!live) return;
            if (det?.box) {
              setFaceBox({
                x: det.box.x / v.videoWidth, y: det.box.y / v.videoHeight,
                w: det.box.width / v.videoWidth, h: det.box.height / v.videoHeight,
              });
            } else {
              setFaceBox(null);
            }
          } catch { /* lewati frame gagal */ }
        }, 450);
      } catch { /* model gagal: status utama yang bicara */ }
    })();
    return () => { live = false; if (timer) clearInterval(timer); };
  }, []);
  // Pindai otomatis (mode verifikasi): jalan sendiri sampai dapat 1 wajah.
  useEffect(() => {
    if (enroll || !modelsReady || failed) return;
    if (scanState !== 'idle') return;
    setScanState('scanning');
  }, [enroll, modelsReady, failed, scanState]);
  useEffect(() => {
    if (enroll || scanState !== 'scanning') return;
    let live = true;
    const t0 = Date.now();
    stableRef.current = 0;
    // Sampel wajib frontal + dekat + stabil 2 frame beruntun.
    // Frame miring/jauh/blur DITOLAK (tidak dikirim ke pencocokan).
    const timer = setInterval(async () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || v.videoWidth === 0) return;
      if (Date.now() - t0 > 20000) {
        if (live) {
          setScanState('timeout');
          setScanHint(null);
        }
        return;
      }
      try {
        const s = await yawFromVideo(v).catch(() => null);
        if (!live) return;
        if (!s) {
          stableRef.current = 0;
          setScanHint('Wajah tidak terdeteksi — kembali ke bingkai.');
          return;
        }
        if (s.faceRatio < 0.16) {
          stableRef.current = 0;
          setScanHint('Mendekat sedikit ke kamera.');
          return;
        }
        if (Math.abs(s.yaw) > 0.10) {
          stableRef.current = 0;
          setScanHint('Hadap depan, jangan miring.');
          return;
        }
        stableRef.current += 1;
        if (stableRef.current < 2) {
          setScanHint('Tahan, jangan bergerak…');
          return;
        }
        const d = await descriptorFromVideo(v);
        if (!live) return;
        if (d) {
          clearInterval(timer);
          setScanState('done');
          setScanHint(null);
          onShotRef.current(d);
        }
      } catch { /* coba frame berikut */ }
    }, 500);
    return () => { live = false; clearInterval(timer); };
  }, [enroll, scanState]);
  const rescan = () => {
    onRescan?.();
    stableRef.current = 0;
    setScanHint(null);
    setScanState('scanning');
  };
  // Pendaftaran terpandu: 1 tahan (depan) → 2 geser kanan → 3 geser kiri.
  // Arah dikalibrasi runtime (tahap 2 boleh sisi mana pun, tahap 3 wajib lawannya)
  // → kebal mirror kamera & tetap dapat sepasang kiri-kanan.
  type Stage = 'idle' | 'center' | 'right' | 'left' | 'done';
  const [stage, setStage] = useState<Stage>('idle');
  const gst = useRef({ stage: 'idle' as Stage, ok: 0, sideSign: 0, descs: [] as number[][], t0: 0 });
  const onEnrollRef = useRef(onEnroll);
  onEnrollRef.current = onEnroll;
  const startGuided = () => {
    if (!modelsReady) {
      setStatus('tunggu model siap dulu…');
      return;
    }
    warmAudio(); // buka kunci audio (butuh gesture) biar ting tahap bunyi
    gst.current = { stage: 'center', ok: 0, sideSign: 0, descs: [], t0: Date.now() };
    setStage('center');
  };
  const resetGuided = () => {
    gst.current = { stage: 'idle', ok: 0, sideSign: 0, descs: [], t0: 0 };
    setStage('idle');
  };
  useEffect(() => {
    if (!enroll || stage === 'idle' || stage === 'done') return;
    const timer = setInterval(async () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || v.videoWidth === 0) return;
      const R = gst.current;
      if (Date.now() - R.t0 > 25000) {
        setStatus('Waktu habis di tahap ini — tap Ulangi untuk coba lagi.');
        R.stage = 'idle';
        setStage('idle');
        return;
      }
      const s = await yawFromVideo(v).catch(() => null);
      if (!s) {
        setStatus('Wajah tidak terdeteksi — kembali ke dalam bingkai.');
        R.ok = 0;
        return;
      }
      if (s.faceRatio < 0.14) {
        setStatus('Mendekat sedikit ke kamera.');
        R.ok = 0;
        return;
      }
      const snap = async () => descriptorFromVideo(v).catch(() => null);
      if (R.stage === 'center') {
        setStatus('Tahap 1/3: TAHAN wajah menghadap depan, jangan bergerak…');
        if (Math.abs(s.yaw) < 0.06) {
          if (++R.ok >= 3) {
            const d = await snap();
            if (d) {
              R.descs.push(d);
              tingStage(0); // tahap 1 lolos
              R.stage = 'right';
              R.ok = 0;
              R.t0 = Date.now();
              setStage('right');
            } else {
              setStatus('Gagal merekam — tahan lagi.');
              R.ok = 0;
            }
          }
        } else {
          R.ok = 0;
          setStatus('Tahap 1/3: hadap DEPAN dulu (wajahmu miring).');
        }
      } else if (R.stage === 'right') {
        setStatus('Tahap 2/3: GESER wajah perlahan ke KANAN…');
        if (Math.abs(s.yaw) > 0.11) {
          if (++R.ok >= 2) {
            const d = await snap();
            if (d) {
              R.descs.push(d);
              tingStage(1); // tahap 2 lolos
              R.sideSign = Math.sign(s.yaw);
              R.stage = 'left';
              R.ok = 0;
              R.t0 = Date.now();
              setStage('left');
            } else {
              setStatus('Gagal merekam — geser lagi.');
              R.ok = 0;
            }
          }
        } else {
          R.ok = 0;
        }
      } else if (R.stage === 'left') {
        setStatus('Tahap 3/3: GESER wajah perlahan ke KIRI…');
        if (s.yaw * R.sideSign < -0.09) {
          if (++R.ok >= 2) {
            const d = await snap();
            if (d) {
              R.descs.push(d);
              tingStage(2); // tahap 3 lolos
              R.stage = 'done';
              setStage('done');
              setStatus('Semua tahap terekam — menyimpan…');
              onEnrollRef.current(R.descs.slice(0, 3), photoFromVideo(v));
            } else {
              setStatus('Gagal merekam — geser lagi.');
              R.ok = 0;
            }
          }
        } else {
          R.ok = 0;
        }
      }
    }, 450);
    return () => clearInterval(timer);
  }, [enroll, stage]);
  const hint = note
    ?? (!modelsReady || failed ? status
      : enroll ? status
      : scanState === 'timeout' ? 'Wajah tidak terdeteksi dalam 20 detik.'
      : scanState === 'done' ? 'Memverifikasi…'
      : (scanHint
        ?? (faceBox ? 'Wajah terlihat — hadap depan…' : 'Memindai wajah otomatis — hadap kamera')));
  const stageIdx = stage === 'center' ? 0 : stage === 'right' ? 1 : stage === 'left' ? 2 : stage === 'done' ? 3 : -1;
  return (
    <div className="camwrap">
      <div className="camcard">
        <b>{title}</b>
        <div className="camview">
          <video ref={videoRef} playsInline muted autoPlay />
          <div className="faceguide" />
          {faceBox && (
            <div
              className="facedetect"
              style={{
                left: `${faceBox.x * 100}%`, top: `${faceBox.y * 100}%`,
                width: `${faceBox.w * 100}%`, height: `${faceBox.h * 100}%`,
              }}
            />
          )}
        </div>
        <p className="hint">{hint}</p>
        {failed && <button className="primary" onClick={() => setTryNo((n) => n + 1)}><RotateCw size={15} /> Coba lagi</button>}
        {enroll && (
          <div className="steps">
            {['Tahan', 'Kanan', 'Kiri'].map((s, i) => (
              <span key={s} className={stageIdx > i ? 'done' : stageIdx === i ? 'now' : ''}>
                {stageIdx > i ? <Check size={12} /> : `${i + 1}.`} {s}
              </span>
            ))}
          </div>
        )}
        <div className="row">
          {enroll ? (
            stage === 'idle'
              ? <button className="primary cta" disabled={!modelsReady} onClick={startGuided}>{modelsReady ? <><ScanFace size={20} /> Mulai Scan Wajah</> : 'memuat model…'}</button>
              : stage === 'done'
                ? <button className="primary" onClick={resetGuided}>Ulangi</button>
                : <button className="primary" disabled>Merekam…</button>
          ) : (
            (scanState === 'timeout' || (note && scanState === 'done')) && (
              <button className="primary" onClick={rescan}><RotateCw size={15} /> Pindai ulang</button>
            )
          )}
          <button onClick={onClose}>Tutup</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('hari');
  const [state, setState] = useState<AppState | null>(null);
  const [checks, setChecks] = useState<TaskRow[]>([]);
  const [ev, setEv] = useState<EvidenceRow[]>([]);
  const [uploadingTugas, setUploadingTugas] = useState<string | null>(null);
  const [pendingTugas, setPendingTugas] = useState<string | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ file: string; judul: string; by: string } | null>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [lapsit, setLapsit] = useState<LapsitRow[]>([]);
  const [lapsitText, setLapsitText] = useState('');
  const [bdOpen, setBdOpen] = useState<Record<number, boolean>>({});
  const [bdDone, setBdDone] = useState<string[]>([]);
  const [faces, setFaces] = useState<FaceRow[]>([]);
  const [att, setAtt] = useState<AttRow[]>([]);
  const [unlocked, setUnlocked] = useState(false); // wajah terverifikasi sesi ini
  const [cam, setCam] = useState<null | { mode: 'absen' | 'login' | 'register' }>(null);
  const [camMsg, setCamMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: 'error' | 'ok' | 'info' } | null>(null);
  const [me, setMe] = useState(() => {
    // Sesi hanya berlaku 1 hari → tiap hari wajib verifikasi wajah ulang.
    try {
      if (localStorage.getItem('piket-me-date') !== dateStr(0)) return '';
      return load('piket-me', '');
    } catch {
      return '';
    }
  });
  const [regName, setRegName] = useState('');
  const [regAngkatan, setRegAngkatan] = useState('');
  const [regJabatan, setRegJabatan] = useState('');
  const [profiling, setProfiling] = useState(false);
  const [hash, setHash] = useState(() => location.hash);
  const [, setTitleTaps] = useState(0);
  const [admin, setAdmin] = useState(() => sessionStorage.getItem('piket-admin') === '1');
  const [showPin, setShowPin] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [online, setOnline] = useState(navigator.onLine);

  const [target, setTarget] = useState('maxwell');
  const [fromDay, setFromDay] = useState<DayKey>('Senin');
  const [toDay, setToDay] = useState<DayKey>('Selasa');
  const [alasan, setAlasan] = useState('');
  const [weekOff, setWeekOff] = useState(0);
  const [weekStat, setWeekStat] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pickDay, setPickDay] = useState<DayKey | null>(null);

  useEffect(() => { save('piket-me', me); }, [me]);
  useEffect(() => {
    try {
      if (me) localStorage.setItem('piket-me-date', dateStr(0));
      else localStorage.removeItem('piket-me-date');
    } catch { /* abaikan */ }
  }, [me]);
  useEffect(() => {
    sessionStorage.setItem('piket-admin', admin ? '1' : '0');
    if (!admin) clearPin();
  }, [admin]);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => {
    // Panaskan model wajah sejak app dibuka → pas tap login sudah siap.
    ensureModels().catch(() => {});
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const refresh = async () => {
    const s = await loadState();
    setState(s);
    if (!s.fromApi) save('piket-schedule', s.schedule);
    const c = s.fromApi ? await loadChecks() : null;
    setChecks(c ?? localChecks());
    const e = s.fromApi ? await loadEvidence(dateStr(0), dateStr(0)) : null;
    setEv(e ?? []);
    setBdDone(load<string[]>(`piket-bd-${dateStr(0)}`, []));
    if (s.fromApi) {
      setFaces(await loadFaces());
      const a = await loadAttendance(dateStr(0), dateStr(0));
      setAtt(a ?? []);
      setLapsit((await loadLapsit(dateStr(0), dateStr(0))) ?? []);
    } else {
      setFaces([]);
      setAtt([]);
      setLapsit([]);
    }
    setUnlocked(sessionStorage.getItem('piket-unlock-date') === dateStr(0));
  };
  useEffect(() => { void refresh(); }, []);

  const members: Member[] = useMemo(
    () => state?.members ?? [], [state],
  );
  const meMember = members.find((m) => m.id === me) ?? null;
  useEffect(() => {
    // Heartbeat presence tiap 30 dtk selama login.
    if (!meMember || !state?.fromApi) return;
    ping(me);
    const t = setInterval(() => ping(me), 30000);
    const onVis = () => { if (document.visibilityState === 'visible') ping(me); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, state?.fromApi]);
  const nama = (id: string) =>
    members.find((m) => m.id === id)?.nama ?? memberById(id).nama;
  const warna = (id: string) =>
    members.find((m) => m.id === id)?.warna ?? memberById(id).warna;

  const today = todayKeyID();
  const tmr = tomorrowKeyID();
  const crew: string[] = today === 'Libur' ? [] : (state?.schedule[today] ?? []);
  const crewBesok: string[] = tmr === 'Libur' ? [] : (state?.schedule[tmr] ?? []);
  const jamHari = today === 'Libur' ? '' : (state?.jam[today] ?? '09.00–15.00');
  const doneCount = checks.filter((c) => c.done).length;
  const pending = (state?.swaps ?? []).filter((s) => s.status === 'pending');
  const bellDot = tmr !== 'Libur' && (state?.schedule[tmr] ?? []).includes(me);

  // ---- Mingguan: tanggal Senin–Jumat minggu tampil + status selesai per tanggal ----
  const ABBR = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum'];
  const weekDates = useMemo(() => {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7; // Senin=0
    const mon = new Date(now);
    mon.setDate(now.getDate() - dow + weekOff * 7);
    return DAYS.map((_, i) => {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
  }, [weekOff]);

  useEffect(() => {
    if (tab !== 'minggu') return;
    let live = true;
    (async () => {
      const out: Record<string, boolean> = {};
      const evRows = state?.fromApi ? await loadEvidence(weekDates[0], weekDates[4]) : null;
      const lapRows = state?.fromApi ? await loadLapsit(weekDates[0], weekDates[4]) : null;
      await Promise.all(weekDates.map(async (ds) => {
        let rows: TaskRow[] | null = null;
        if (state?.fromApi) {
          rows = await loadChecks(ds);
        } else {
          rows = localChecks(ds);
        }
        const tasksDone = !!rows?.length && rows.every((r) => r.done);
        if (!tasksDone) return;
        // tiap tugas wajib ada 1 foto (siapa pun boleh upload) + lapsit terkirim
        let evOk = true;
        if (state?.fromApi && evRows) {
          const titles = (rows ?? []).map((r) => r.judul);
          evOk = titles.length > 0 && titles.every((t) =>
            evRows.some((e) => e.tanggal === ds && e.tugas === t));
        }
        const lapOk = !state?.fromApi || !lapRows ? evOk : (lapRows ?? []).some((l) => l.tanggal === ds);
        if (evOk && lapOk) out[ds] = true;
      }));
      if (live) setWeekStat(out);
    })();
    return () => { live = false; };
  }, [tab, weekOff, state?.fromApi]);

  const rangeLabel = (() => {
    const a = new Date(weekDates[0] + 'T00:00');
    const b = new Date(weekDates[4] + 'T00:00');
    const m = new Intl.DateTimeFormat('id-ID', { month: 'long' });
    return a.getMonth() === b.getMonth()
      ? `${a.getDate()}–${b.getDate()} ${m.format(b)}`
      : `${a.getDate()} ${m.format(a)} – ${b.getDate()} ${m.format(b)}`;
  })();

  const putarRotasi = async () => {    if (!state || !admin) return;
    if (!confirm('Putar rotasi? Crew tiap hari geser maju 1 hari (Jumat → Senin).')) return;
    const sch = state.schedule;
    const next = { Senin: sch.Jumat, Selasa: sch.Senin, Rabu: sch.Selasa, Kamis: sch.Rabu, Jumat: sch.Kamis };
    setState({ ...state, schedule: next });
    if (state.fromApi) await saveRosterRemote(next, state.jam);
    else save('piket-schedule', next);
    setWeekOff(0);
  };

  // ---- Tukar: tanggal minggu berjalan + slot giliran ----
  const tukarDates = useMemo(() => {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7; // Senin=0
    const mon = new Date(now);
    mon.setDate(now.getDate() - dow);
    return DAYS.map((_, i) => {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
  }, []);
  const dayDate = (d: DayKey) => {
    const i = DAYS.indexOf(d);
    return `${ABBR[i]} ${new Date(tukarDates[i] + 'T00:00').getDate()}`;
  };
  const mySlots = useMemo(
    () => DAYS.filter((d) => state?.schedule[d]?.includes(me)), [state, me],
  );

  // jaga default pilihan tetap valid saat ganti user / data reload
  useEffect(() => {
    if (!state) return;
    if (!state.schedule[fromDay]?.includes(me)) {
      const first = DAYS.find((d) => state.schedule[d]?.includes(me));
      if (first) setFromDay(first);
    }
    if (target === me || !state.schedule[toDay]?.includes(target) || toDay === fromDay) {
      const cand = DAYS.flatMap((d) =>
        (state.schedule[d] ?? []).filter((m) => m !== me).map((m) => ({ d, m })),
      ).find((c) => c.d !== (state.schedule[fromDay]?.includes(me) ? fromDay : DAYS.find((d) => state.schedule[d]?.includes(me))));
      if (cand) { setToDay(cand.d); setTarget(cand.m); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, me, fromDay]);

  const taskTap = (c: TaskRow) => {
    if (!unlocked) return needVerify();
    const hasPhoto = ev.some((e) => e.tugas === c.judul);
    if (!hasPhoto) return pickPhoto(c.judul); // ceklis wajib foto dulu
    // Immutable: sudah ada foto = final, tidak bisa uncheck/ganti.
    setToast({ msg: 'Laporan foto wajib sudah diterima, tidak perlu melakukannya 2x.', kind: 'info' });
  };

  const onFile = async (judul: string, f: File | undefined) => {
    if (!f || !judul) return;
    setUploadingTugas(judul);
    try {
      const dataUrl = await stampPhoto(f, geo); // kompres + stempel tgl/jam (+koordinat)
      const res = await uploadEvidence(dateStr(0), me, judul, dataUrl);
      if (!res.ok) {
        alert(res.error ?? 'Gagal upload');
      } else {
        // server otomatis menandai tugas selesai → refresh keduanya
        const [c, e] = await Promise.all([loadChecks(dateStr(0)), loadEvidence(dateStr(0), dateStr(0))]);
        if (c) setChecks(c);
        if (e) setEv(e);
      }
    } catch {
      alert('Baca/kompres foto gagal');
    } finally {
      setUploadingTugas(null);
      setPendingTugas(null);
    }
  };

  const pickPhoto = (judul: string) => {
    setPendingTugas(judul);
    photoRef.current?.click();
  };

  const toggleBd = (key: string) => {
    if (!unlocked) return needVerify();
    setBdDone((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      save(`piket-bd-${dateStr(0)}`, next);
      return next;
    });
  };

  const kirimLapsit = async () => {
    if (!unlocked) return needVerify();
    if (!state?.fromApi) return alert('Butuh online untuk kirim lapsit.');
    const g = (await getGeo()) ?? geo;
    if (g) setGeo(g);
    const res = await submitLapsit(dateStr(0), me, lapsitText, g);
    if (!res.ok) return alert(res.error ?? 'Gagal kirim lapsit');
    setLapsitText('');
    const rows = await loadLapsit(dateStr(0), dateStr(0));
    if (rows) setLapsit(rows);
  };

  const needVerify = () => {
    if (!state?.fromApi) return alert('Butuh online untuk verifikasi wajah.');
    if (!meMember) return;
    if (!crew.includes(me)) {
      return alert('Kamu tidak ada jadwal hari ini — minta Admin susun roster dulu (tab Mingguan, mode Admin).');
    }
    warmAudio();
    setCamMsg(null);
    setCam({ mode: 'absen' });
  };

  const loginCam = () => {
    if (!state?.fromApi) return alert('Butuh online untuk masuk.');
    warmAudio();
    setCamMsg(null);
    setCam({ mode: 'login' }); // selalu kamera dulu; wajah baru → form nama+angkatan
  };

  const logout = () => {
    setMe('');
    setUnlocked(false);
    try { sessionStorage.removeItem('piket-unlock-date'); } catch { /* abaikan */ }
  };

  const onProfileDone = (p: Profile) => {
    setRegName(p.nama);
    setRegAngkatan(p.angkatan);
    setRegJabatan(p.jabatan);
    setProfiling(false);
    warmAudio();
    setCamMsg('Tap Mulai, ikuti tahap: tahan – kanan – kiri');
    setCam({ mode: 'register' });
  };

  const handleEnroll = async (ds: number[][], photo: string | null) => {
    const parsed = profileSchema.safeParse({ nama: regName, angkatan: regAngkatan, jabatan: regJabatan });
    if (!parsed.success) {
      setCamMsg(parsed.error.issues[0]?.message ?? 'Profil invalid.');
      return;
    }
    if (!photo) {
      setCamMsg('Foto gagal diambil, coba lagi.');
      return;
    }
    // Tolak wajah yang sudah terdaftar (nama beda pun tetap ketahuan)
    const enrolled = faces.map((f) => ({ memberId: f.memberId, descriptors: f.descriptors }));
    for (const d of ds) {
      const dupe = identify(d, enrolled);
      if (dupe) {
        const msg = `Wajah ini sudah terdaftar sebagai ${nama(dupe.memberId)} — pakai Masuk, jangan daftar lagi.`;
        setCamMsg(msg);
        setToast({ msg, kind: 'error' });
        return;
      }
    }
    const res = await registerMember(parsed.data.nama, parsed.data.angkatan, parsed.data.jabatan, ds, photo);
    if (res.ok && res.memberId) {
      const hello = `${parsed.data.nama} (${parsed.data.jabatan}, angkatan ${parsed.data.angkatan})`;
      await refresh();
      setMe(res.memberId);
      setUnlocked(true); // wajah baru saja diverifikasi → langsung terbuka
      try { sessionStorage.setItem('piket-unlock-date', dateStr(0)); } catch { /* abaikan */ }
      void getGeo().then(setGeo);
      setRegName('');
      setRegAngkatan('');
      setRegJabatan('');
      setProfiling(false);
      setCam(null);
      setCamMsg(null);
      alert('Pendaftaran berhasil — kamu masuk sebagai ' + hello);
    } else {
      setCamMsg(res.error ?? 'Gagal daftar.');
    }
  };

  const handleDescriptor = async (d: number[]) => {
    if (!cam) return;
    const enrolled = faces.map((f) => ({ memberId: f.memberId, descriptors: f.descriptors }));
    if (cam.mode === 'login') {
      const hit = identify(d, enrolled);
      if (!hit) {
        setCam(null);
        setCamMsg(null);
        setProfiling(true); // wajah baru → isi nama + angkatan
        return;
      }
      setMe(hit.memberId);
      ting(990, 0.18); // masuk
      setCam(null);
      setCamMsg(null);
      return;
    }
    if (cam.mode !== 'absen') return;
    const hit = identify(d, enrolled);
    if (!hit) {
      setCamMsg('Wajah tidak dikenal — Daftar dulu ya.');
      return;
    }
    if (hit.memberId !== me) {
      setCamMsg(`Terdeteksi ${nama(hit.memberId)}, bukan ${nama(me)} — keluar lalu masuk lagi, atau coba lagi.`);
      return;
    }
    await markAttendance(dateStr(0), me);
    const a = await loadAttendance(dateStr(0), dateStr(0));
    if (a) setAtt(a);
    setUnlocked(true);
    try { sessionStorage.setItem('piket-unlock-date', dateStr(0)); } catch { /* abaikan */ }
    ting(990, 0.18); // absen lolos
    setToast({ msg: 'Absen berhasil — checklist & bukti terbuka', kind: 'ok' });
    void getGeo().then(setGeo); // siapkan koordinat untuk stempel foto
    setCam(null);
    setCamMsg(null);
  };

  const submitSwap = async () => {
    if (target === me) return alert('Pilih rekan tukar yang beda.');
    if (!state) return;
    if (fromDay === toDay) return alert('Hari asal & tujuan harus beda.');
    if (!state.schedule[fromDay]?.includes(me)) return alert(`Kamu tidak piket di ${fromDay}.`);
    if (!state.schedule[toDay]?.includes(target)) return alert(`${nama(target)} tidak piket di ${toDay}.`);
    if (state.fromApi) {
      const ok = await createSwapRemote({ requester: me, target, fromDay, toDay, alasan });
      if (!ok) return alert('Gagal simpan (server mati?).');
    } else {
      const cur = load<SwapRow[]>('piket-swaps', []);
      save('piket-swaps', [{ id: Math.random().toString(36).slice(2, 9), requester: me, target, fromDay, toDay, alasan, status: 'pending', createdAt: Date.now() }, ...cur]);
    }
    setAlasan('');
    void refresh();
  };

  const decide = async (w: SwapRow, approve: boolean) => {
    if (state?.fromApi) {
      await decideSwapRemote(w.id, approve);
    } else {
      const cur = load<SwapRow[]>('piket-swaps', []).map((x) =>
        x.id === w.id ? { ...x, status: approve ? ('approved' as const) : ('rejected' as const) } : x);
      save('piket-swaps', cur);
      if (approve && state) {
        const sch = { ...state.schedule };
        sch[w.fromDay] = sch[w.fromDay].map((m) => (m === w.requester ? w.target : m));
        sch[w.toDay] = sch[w.toDay].map((m) => (m === w.target ? w.requester : m));
        save('piket-schedule', sch);
      }
    }
    void refresh();
  };

  const addTo = async (day: DayKey, id: string) => {
    if (!state) return;
    if (state.schedule[day].includes(id)) return;
    const sch = { ...state.schedule, [day]: [...state.schedule[day], id] };
    setState({ ...state, schedule: sch });
    if (state.fromApi) await saveRosterRemote(sch, state.jam);
    else save('piket-schedule', sch);
  };
  const removeFrom = async (day: DayKey, id: string) => {
    if (!state) return;
    const sch = { ...state.schedule, [day]: state.schedule[day].filter((m) => m !== id) };
    setState({ ...state, schedule: sch });
    if (state.fromApi) await saveRosterRemote(sch, state.jam);
    else save('piket-schedule', sch);
  };

  const jamColon = (day: DayKey, idx: 0 | 1): string => {
    const parts = (state?.jam[day] ?? '09.00–15.00').split('–');
    return (parts[idx] ?? (idx === 0 ? '09.00' : '15.00')).replace('.', ':');
  };

  const setJam = async (day: DayKey, which: 'mulai' | 'selesai', colon: string) => {
    if (!state || !/^\d{2}:\d{2}$/.test(colon)) return;
    const dot = colon.replace(':', '.');
    const [m, s] = (state.jam[day] ?? '09.00–15.00').split('–');
    const next = {
      ...state.jam,
      [day]: which === 'mulai' ? `${dot}–${s ?? '15.00'}` : `${m ?? '09.00'}–${dot}`,
    };
    setState({ ...state, jam: next });
    if (state.fromApi) await saveRosterRemote(state.schedule, next);
  };

  const hapusMember = async (id: string) => {    if (!confirm(`Hapus ${nama(id)} + wajah & jadwalnya?`)) return;
    const ok = await deleteMember(id);
    if (!ok) return alert('Gagal hapus (butuh PIN Admin / online).');
    if (me === id) logout();
    void refresh();
  };

  const gearClick = () => {
    if (admin) return setAdmin(false); // keluar mode Admin
    if (!state || !state.fromApi) return setAdmin(true); // offline: lokal saja
    setPinInput('');
    setShowPin(true);
  };

  const submitPin = async () => {
    const res = await verifyPin(pinInput);
    if (res === null) {
      // server unreachable → anggap offline, izinkan lokal
      setAdmin(true);
    } else if (res) {
      setAdmin(true);
    } else {
      return alert('PIN salah.');
    }
    setShowPin(false);
    setPinInput('');
  };

  const enableNotif = async () => {
    if (!('Notification' in window)) return alert('Browser tidak dukung notifikasi.');
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      new Notification('Jadwal Piket Menwa USB YPKP', {
        body: tmr === 'Libur' ? 'Besok libur, tidak ada piket.'
          : (state?.schedule[tmr] ?? []).includes(me)
            ? `H-1: besok (${tmr}) giliran kamu piket!` : `Besok (${tmr}) bukan giliranmu. Aman.`,
      });
    }
  };

  useEffect(() => {
    const h = () => setHash(location.hash);
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  // Pintu dev: tap judul 5× → dashboard superadmin.
  const titleTap = () => {
    setTitleTaps((n) => {
      if (n + 1 >= 5) {
        location.hash = 'super';
        return 0;
      }
      return n + 1;
    });
  };
  if (hash === '#super') {
    return (
      <div className="phone wide">
        <SuperView onExit={() => { location.hash = ''; }} />
      </div>
    );
  }

  const camModal = cam && (    <FaceCam
      title={cam.mode === 'register'
        ? 'Daftar anggota baru'
        : cam.mode === 'login'
          ? 'Masuk dengan wajah'
          : `Absen ${nama(me)}`}
      note={camMsg}
      enroll={cam.mode === 'register'}
          onShot={(d) => void handleDescriptor(d)}
          onEnroll={(ds, photo) => void handleEnroll(ds, photo)}
          onClose={() => { setCam(null); setCamMsg(null); }}
          onRescan={() => setCamMsg(null)}
    />
  );

  // Gate: belum masuk → welcome / form profil. Daily page hanya utk yg login.
  if (!meMember) {
    return (
      <div className="phone">
        {profiling
          ? <ProfilePage onDone={onProfileDone} />
          : <WelcomePage onTap={loginCam} onRegister={() => setProfiling(true)} />}
        {camModal}
        {toast && (
          <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>
            {toast.kind === 'ok' ? <Check size={16} /> : toast.kind === 'info' ? <Info size={16} /> : <TriangleAlert size={16} />} {toast.msg}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="phone">
      <header className="hd">
        <div onClick={titleTap}>
          <h1>Jadwal Piket Menwa USB YPKP</h1>
          <p>{todayLong()} • {members.length} anggota{state && !state.fromApi ? ' • offline' : ''}</p>
        </div>
        <div className="hbtns">
          <button className="iconbtn" onClick={gearClick} title="mode Admin"><Settings size={19} /></button>
          <button className="iconbtn bell" onClick={enableNotif} title="pengingat H-1">
            <Bell size={19} />{bellDot && <i className="dot" />}
          </button>
        </div>
      </header>
      {!online && <div className="offline">● offline — data lokal</div>}
      {admin && <div className="adminbar">mode Admin aktif — kelola di tab Mingguan/Tukar</div>}
      {showPin && (
        <div className="pinsheet">
          <b>Masuk mode Admin</b>
          <span className="dim">Masukkan PIN Admin (1× per sesi)</span>
          <input
            type="password" inputMode="numeric" autoFocus
            placeholder="PIN Admin" value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitPin(); }}
          />
          <div className="row">
            <button className="primary" onClick={submitPin}>Masuk</button>
            <button onClick={() => setShowPin(false)}>Batal</button>
          </div>
        </div>
      )}

      <div className="mebar">
        {meMember ? (
          <>
            <span>Masuk sebagai {meMember.foto ? <img className="ava" src={meMember.foto} alt={meMember.nama} /> : null}<b>{meMember.nama}</b>{meMember.jabatan ? ` · ${meMember.jabatan}` : ''}{meMember.angkatan ? ` ${meMember.angkatan}` : ''}</span>
            <button className="ghost" onClick={logout}><LogOut size={13} /> Logout</button>
          </>
        ) : (
          <span className="hint">Belum masuk.</span>
        )}
      </div>

      <main>
        {tab === 'hari' && (
          <>
            <p className="tgl">{todayLong()}</p>
            {today === 'Libur' ? (
              <div className="hero"><b><PartyPopper size={17} /> Libur</b><span>Sabtu–Minggu tidak ada piket.</span></div>
            ) : (
              <div className="hero">
                <div className="herorow">
                  <i className="pdot" style={{ background: warna(crew[0] ?? '') }} />
                  <div>
                    <b>{crew.map(nama).join(' & ') || '—'}</b>
                    <span>Piket hari ini • {jamHari}</span>
                  </div>
                  <em className="pill">hari ini</em>
                </div>
              </div>
            )}
            {today !== 'Libur' && (
              <>
                {mySlots.length === 0 && (
                  <p className="hint">Kamu belum masuk roster minggu ini — minta Admin tambahkan via tab Mingguan (mode Admin).</p>
                )}
                <h2>Kehadiran</h2>
                <div className="attlist">
                  {crew.map((id) => {
                    const row = att.find((a) => a.memberId === id);
                    const m = members.find((x) => x.id === id);
                    return (
                      <div key={id} className="attrow">
                        <i style={{ background: warna(id) }} /><span>{nama(id)}</span>
                        {m && isOnline(m) && <i className="onlinedot" title="online" />}
                        <em className={row ? 'badge-ok' : 'badge-no'}>{row ? `hadir ${row.jam}` : 'belum'}</em>
                      </div>
                    );
                  })}
                </div>
                {crew.includes(me) && !unlocked && (
                  <button className="bigbtn" onClick={needVerify}>
                    {att.some((a) => a.memberId === me) ? <><LockOpen size={15} /> Verifikasi wajah (buka checklist)</> : <><Camera size={15} /> Absen tiba (selfie wajah)</>}
                  </button>
                )}
                {unlocked && <p className="hint"><Check size={13} /> Wajah terverifikasi — checklist & bukti terbuka sesi ini.</p>}
                <h2>Bukti Piket (Wajib)</h2>
                {!unlocked && <p className="hint"><Lock size={12} /> Verifikasi wajah dulu untuk membuka bukti.</p>}
                <ul className="tasks">
                  {checks.map((c) => {
                    const ph = ev.find((e) => e.tugas === c.judul);
                    const busy = uploadingTugas === c.judul;
                    return (
                      <li
                        key={c.judul}
                        className={unlocked ? '' : 'locked'}
                        onClick={() => taskTap(c)}
                      >
                        <button
                          className="cam"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!unlocked) return needVerify();
                            if (ph) setPreview({ file: ph.file, judul: c.judul, by: nama(ph.memberId) });
                            else pickPhoto(c.judul);
                          }}
                        >
                          {ph
                            ? <img src={ph.file} alt={c.judul} />
                            : busy ? <span className="spin" /> : <Camera size={17} />}
                        </button>
                        <span className={`ttitle ${c.done ? 'strike' : ''}`}>{c.judul}</span>
                        <span className={`box ${c.done ? 'on' : ''}`}>{c.done ? <Check size={13} /> : ''}</span>
                      </li>
                    );
                  })}
                </ul>
                <input
                  ref={photoRef} type="file" accept="image/*" capture="environment" hidden
                  onChange={(e) => { void onFile(pendingTugas ?? '', e.target.files?.[0]); e.target.value = ''; }}
                />
                <p className="hint">1 tugas = 1 foto (siapa pun yang piket boleh moto). Tap kamera untuk lihat/ganti, tap judul untuk centang. {ev.length}/{checks.length} berfoto.</p>
                <h2>Rincian Tugas (Opsional)</h2>
                <p className="hint">Tanpa foto — cukup centang, tersimpan di HP ini.</p>
                {BREAKDOWN.map((g, gi) => {
                  const done = g.items.filter((_, ii) => bdDone.includes(`${gi}:${ii}`)).length;
                  const open = !!bdOpen[gi];
                  return (
                    <div key={gi} className="bdgroup">
                      <button className="bdhead" onClick={() => setBdOpen((o) => ({ ...o, [gi]: !o[gi] }))}>
                        <span>{gi + 1}. {g.title}</span>
                        <em>{done}/{g.items.length}</em>
                      </button>
                      {open && (
                        <ul className="tasks">
                          {g.items.map((it, ii) => {
                            const k = `${gi}:${ii}`;
                            const on = bdDone.includes(k);
                            return (
                              <li key={k} className={unlocked ? '' : 'locked'} onClick={() => toggleBd(k)}>
                                <span className={`box ${on ? 'on' : ''}`}>{on ? <Check size={13} /> : ''}</span>
                                <span className={on ? 'strike' : ''}>{it}</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
                <h2>Catatan Lapsit — Akhir Piket</h2>
                {lapsit.length > 0 ? (
                  lapsit.map((l) => (
                    <div key={l.id} className="card sm">
                      <b>{nama(l.memberId)}</b>
                      <span>{l.catatan}</span>
                      <span className="dim">
                        {new Date(l.createdAt).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        {l.lat && l.lng ? ` • ${Number(l.lat).toFixed(5)}, ${Number(l.lng).toFixed(5)}` : ' • GPS off'}
                      </span>
                    </div>
                  ))
                ) : (
                  <>
                    <textarea
                      className="reason" rows={3}
                      placeholder="Tulis laporan situasi akhir piket…"
                      value={lapsitText} onChange={(e) => setLapsitText(e.target.value)}
                    />
                    <button
                      className="bigbtn"
                      disabled={!unlocked || ev.length < checks.length || checks.length === 0}
                      onClick={kirimLapsit}
                    >
                      Kirim lapsit akhir piket
                    </button>
                    {unlocked && (ev.length < checks.length) && (
                      <p className="hint">Lengkapi {checks.length} foto bukti dulu.</p>
                    )}
                  </>
                )}
                {tmr !== 'Libur' && crewBesok.length > 0 && (
                  <p className="besok">● Besok: {crewBesok.map(nama).join(' & ')} • mulai {(state?.jam[tmr] ?? '09.00–15.00').split('–')[0]}</p>
                )}
              </>
            )}
          </>
        )}

        {tab === 'minggu' && (
          <>
            <div className="weeknav">
              <b>{rangeLabel}</b>
              <span>
                <button onClick={() => setWeekOff((w) => w - 1)}>‹</button>
                <button onClick={() => setWeekOff((w) => w + 1)}>›</button>
              </span>
            </div>
            {DAYS.map((d, i) => {
              const ds = weekDates[i];
              const isToday = ds === dateStr(0);
              const crewIds = state?.schedule[d] ?? [];
              return (
                <div key={d} className={`dayrow ${isToday ? 'now' : ''}`}>
                  <div className="dleft"><b>{ABBR[i]}</b><span>{new Date(ds + 'T00:00').getDate()}</span></div>
                  <div className="dmain">
                    <span className="dots">{crewIds.map((id) => <i key={id} style={{ background: warna(id) }} />)}</span>
                    <span className="dnames">{crewIds.map(nama).join(' • ') || '—'}</span>
                    {admin && (
                      <span className="dedit">
                        {crewIds.map((id) => (
                          <button key={id} className="x" onClick={() => removeFrom(d, id)}>{nama(id)} <X size={11} /></button>
                        ))}
                        <button className="addbtn" onClick={() => setPickDay(pickDay === d ? null : d)}>
                          <Plus size={13} /> Tambah personel
                        </button>
                        <span className="jamrow">
                          <Clock size={13} />
                          <label>mulai
                            <input type="time" value={jamColon(d, 0)} onChange={(e) => void setJam(d, 'mulai', e.target.value)} />
                          </label>
                          <span className="dash">–</span>
                          <label>selesai
                            <input type="time" value={jamColon(d, 1)} onChange={(e) => void setJam(d, 'selesai', e.target.value)} />
                          </label>
                        </span>
                        {pickDay === d && (
                          <span className="picklist">
                            {members.filter((m) => !crewIds.includes(m.id)).map((m) => (
                              <button key={m.id} onClick={() => void addTo(d, m.id)}>
                                {m.foto
                                  ? <img className="ava" src={m.foto} alt={m.nama} />
                                  : <i className="pdot" style={{ background: m.warna }} />}
                                <span>{m.nama}{m.jabatan ? <small> · {m.jabatan}</small> : ''}</span>
                                <Plus size={14} />
                              </button>
                            ))}
                            {members.filter((m) => !crewIds.includes(m.id)).length === 0 && (
                              <span className="hint">Semua anggota sudah di hari ini.</span>
                            )}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  {isToday
                    ? <em className="pill sm">hari ini</em>
                    : weekStat[ds]
                      ? <em className="badge-ok"><Check size={11} /> selesai</em>
                      : <em className="badge-idle" />}
                </div>
              );
            })}
            {admin && <button className="rotbtn" onClick={putarRotasi}><Repeat size={14} /> Putar rotasi minggu depan (Admin)</button>}
            {admin && (
              <>
                <h2 className="sec">Anggota terdaftar ({members.length})</h2>
                {!state?.fromApi
                  ? <p className="hint">Butuh online untuk lihat pendaftar.</p>
                  : members.length === 0
                    ? <p className="hint">Belum ada yang daftar — suruh buka tab Hari Ini → Daftar.</p>
                    : members.map((m) => {
                      const n = faces.find((f) => f.memberId === m.id)?.descriptors.length ?? 0;
                      return (
                        <div key={m.id} className="facerow">
                          {m.foto
                            ? <img className="ava" src={m.foto} alt={m.nama} />
                            : <i style={{ background: m.warna }} />}
                          <span>{m.nama}{m.jabatan ? ` · ${m.jabatan}` : ''}{m.angkatan ? ` ${m.angkatan}` : ''}</span>
                          {isOnline(m) && <i className="onlinedot" title="online" />}
                          <em className={n ? 'badge-ok' : 'badge-no'}>{n ? <>wajah <Check size={11} /></> : 'tanpa wajah'}</em>
                          <button onClick={() => void hapusMember(m.id)}>hapus</button>
                        </div>
                      );
                    })}
              </>
            )}
          </>
        )}

        {tab === 'tukar' && (
          <>
            <h2 className="sec">Giliran kamu</h2>
            {!meMember ? (
              <p className="hint">Masuk dengan wajah dulu (tab Hari Ini).</p>
            ) : (
            <div className="opts2">
              {mySlots.map((d) => (
                <button key={d} className={`opt ${fromDay === d ? 'sel' : ''}`} onClick={() => setFromDay(d)}>
                  <i style={{ background: warna(me) }} />{nama(me)} • {dayDate(d)}
                </button>
              ))}
              {mySlots.length === 0 && <p className="hint">Kamu tidak ada jadwal minggu ini.</p>}
            </div>
            )}
            <h2 className="sec">Tukar dengan</h2>
            <div className="opts1">
              {DAYS.flatMap((d) =>
                (state?.schedule[d] ?? []).filter((m) => m !== me).map((m) => ({ d, m })),
              ).map(({ d, m }) => (
                <button
                  key={`${d}-${m}`}
                  className={`opt ${toDay === d && target === m ? 'sel' : ''}`}
                  onClick={() => { setToDay(d); setTarget(m); }}
                >
                  <i style={{ background: warna(m) }} />{nama(m)} • {dayDate(d)}
                </button>
              ))}
            </div>
            <textarea
              className="reason" rows={3}
              placeholder="Alasan (opsional), misal: ada ujian pagi"
              value={alasan} onChange={(e) => setAlasan(e.target.value)}
            />
            <button className="bigbtn" onClick={submitSwap}>Kirim permintaan tukar</button>
            <h2 className="sec">Menunggu persetujuan{pending.length ? ` (${pending.length})` : ''}</h2>
            {pending.length === 0 && <p className="hint">Tidak ada pengajuan menunggu.</p>}
            {pending.map((w) => (
              <div key={w.id}>
                <div className="waitcard">
                  <i className="pdot" style={{ background: warna(w.requester) }} />
                  <span>{nama(w.requester)} meminta tukar<br />{dayDate(w.fromDay)} <ArrowLeftRight size={12} /> {dayDate(w.toDay)}</span>
                  {admin
                    ? <button className="ketua" onClick={() => setExpanded(expanded === w.id ? null : w.id)}>aksi Admin</button>
                    : <em className="ketua static">aksi Admin</em>}
                </div>
                {admin && expanded === w.id && (
                  <div className="row waitrow">
                    <button className="primary" onClick={() => { setExpanded(null); decide(w, true); }}>Approve</button>
                    <button onClick={() => { setExpanded(null); decide(w, false); }}>Tolak</button>
                  </div>
                )}
              </div>
            ))}
            {(state?.swaps ?? []).some((s) => s.status !== 'pending') && (
              <>
                <h2 className="sec">Riwayat</h2>
                {(state?.swaps ?? []).filter((s) => s.status !== 'pending').map((s) => (
                  <p key={s.id} className="hist">{nama(s.requester)} <ArrowLeftRight size={11} /> {nama(s.target)} • {s.fromDay} <ArrowLeftRight size={11} /> {s.toDay} • {s.status}</p>
                ))}
              </>
            )}
          </>
        )}
      </main>

      {tab === 'hari' && checks.length > 0 && (
        <div className="progress"><i style={{ width: `${(doneCount / checks.length) * 100}%` }} /></div>
      )}
      {camModal}
      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>
          {toast.kind === 'ok' ? <Check size={16} /> : toast.kind === 'info' ? <Info size={16} /> : <TriangleAlert size={16} />} {toast.msg}
        </div>
      )}
      {preview && (
        <div className="preview" onClick={() => setPreview(null)}>
          <div className="pvcard" onClick={(e) => e.stopPropagation()}>
            <img src={preview.file} alt={preview.judul} />
            <b>{preview.judul}</b>
            <span className="hint">oleh {preview.by} • {dateStr(0).split('-').reverse().join('/')} • final, tidak bisa diubah</span>
            <div className="row">
              <button className="primary" onClick={() => setPreview(null)}>Tutup</button>
            </div>
          </div>
        </div>
      )}
      <nav className="tabs">
        <button className={tab === 'hari' ? 'on' : ''} onClick={() => setTab('hari')}><CalendarDays size={20} /><span>Hari Ini</span></button>
        <button className={tab === 'minggu' ? 'on' : ''} onClick={() => setTab('minggu')}><CalendarRange size={20} /><span>Mingguan</span></button>
        <button className={tab === 'tukar' ? 'on' : ''} onClick={() => setTab('tukar')}><ArrowLeftRight size={20} /><span>Tukar{pending.length ? ` (${pending.length})` : ''}</span></button>
      </nav>
    </div>
  );
}
