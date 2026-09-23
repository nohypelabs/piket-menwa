import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, closestCenter,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import {
  ArrowLeftRight, Bell, CalendarDays, CalendarRange, Camera, Check, ChevronDown, Clock, GripVertical, Info, Lock,
  LockOpen, PartyPopper, Plus, Repeat, RotateCw, ScanFace, Settings,
  TriangleAlert, X,
} from 'lucide-react';
import {
  cancelSwapRemote, clearPin, clearWeekRosterRemote, createSwapRemote, decideSwapRemote,
  dropPush, ensurePush, loadAttendance, loadBreakdown, loadChecks, loadEvidence, loadFaceSummary,
  loadNilaiToday, matchFace,
  loadLapsit, loadState, loadWeekRoster, localChecks, loginPin, markAttendance, ping, isOnline,
  registerMember, saveRosterRemote, saveWeekRosterRemote, setLoginPin, setProfilePhoto, submitLapsit,
  toggleBreakdown, uploadEvidence, verifyPin,
  type AppState, type AttRow, type EvidenceRow, type FaceSummary, type LapsitRow,
  type Member, type SwapRow, type TaskRow,
} from './api';
import { getGeo, compressPhoto, stampPhoto, type Geo } from './bukti';
import { BREAKDOWN } from './breakdown';
import { descriptorFromVideo, ensureModels, getFaceApi, ting, tingStage, warmAudio, yawFromVideo } from './face';
import { ProfilePage, WelcomePage, profileSchema, type Profile } from './Welcome';
import SuperView from './Super';
import { DAYS, dateStr, load, memberById, save, todayKeyID, tomorrowKeyID, type DayKey } from './piket';

type Tab = 'hari' | 'minggu' | 'tukar';

// Flag "sudah verifikasi wajah hari ini" harus terikat PER-ANGGOTA, bukan
// cuma per-tanggal — device sering gantian dipakai beberapa anggota piket
// (satu HP/tablet bersama). Kalau cuma per-tanggal, anggota kedua yang
// login di device yang sama otomatis kebaca "unlocked" dari sesi anggota
// pertama walau dia sendiri belum verifikasi (bug tombol absen kedip lalu
// hilang: sempat unlocked=false sesaat, lalu ke-overwrite true oleh flag
// stale milik orang lain begitu `me` di-set).
const unlockKey = (memberId: string) => `piket-unlock-date:${memberId}`;

const fmtTanggal = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
const todayLong = () => {
  const s = fmtTanggal.format(new Date());
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const tabTitle: Record<Tab, string> = {
  hari: 'Jadwal Piket Hari Ini',
  minggu: 'Jadwal Mingguan',
  tukar: 'Tukar Jadwal',
};

// Toast global (error/info/ok) dengan animasi framer-motion.
function Toast({ t, onClose }: { t: { msg: string; kind: 'error' | 'ok' | 'info' }; onClose: () => void }) {
  return (
    <motion.div
      className={`toast ${t.kind}`} onClick={onClose}
      initial={{ opacity: 0, y: -14, x: '-50%' }}
      animate={{ opacity: 1, y: 0, x: '-50%' }}
      exit={{ opacity: 0, y: -14, x: '-50%' }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
    >
      {t.kind === 'ok' ? <Check size={16} /> : t.kind === 'info' ? <Info size={16} /> : <TriangleAlert size={16} />} {t.msg}
    </motion.div>
  );
}

// Modal kamera selfie: sekali-ambil (verifikasi/absen) atau burst (daftar).
function FaceCam({ title, note, enroll, onShot, onEnroll, onClose, onRescan, onDuplicate, onPinLogin, checkDuplicate }: {
  title: string; note: string | null; enroll?: boolean;
  onShot: (d: number[]) => void; onEnroll: (ds: number[][]) => void;
  onClose: () => void; onRescan?: () => void; onDuplicate?: (memberId: string) => void;
  onPinLogin?: (pin: string) => Promise<{ ok: boolean; error?: string }>;
  // Cek server: descriptor ini sudah terdaftar sebagai siapa? (tidak pernah
  // menerima embedding member lain ke client — cukup hasil match saja)
  checkDuplicate: (d: number[]) => Promise<{ memberId: string } | null>;
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
  const [scanProg, setScanProg] = useState(8);
  const [showPin, setShowPin] = useState(false);
  const [pinIn, setPinIn] = useState('');
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const submitPin = async () => {
    if (!onPinLogin) return;
    setPinBusy(true);
    setPinErr(null);
    const r = await onPinLogin(pinIn);
    setPinBusy(false);
    if (!r.ok) setPinErr(r.error ?? 'Gagal masuk.');
  };
  const stableRef = useRef(0);
  const onShotRef = useRef(onShot);
  onShotRef.current = onShot;
  const vib = (p: number | number[]) => {
    try { navigator.vibrate?.(p); } catch { /* abaikan */ }
  };
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
          setScanProg(8);
          setScanHint('Wajah tidak terdeteksi — kembali ke bingkai.');
          return;
        }
        if (s.faceRatio < 0.16) {
          stableRef.current = 0;
          setScanProg(12);
          setScanHint('Mendekat sedikit ke kamera.');
          return;
        }
        if (Math.abs(s.yaw) > 0.10) {
          stableRef.current = 0;
          setScanProg(20);
          setScanHint('Hadap depan, jangan miring.');
          return;
        }
        stableRef.current += 1;
        if (stableRef.current < 2) {
          setScanProg(60);
          setScanHint('Tahan, jangan bergerak…');
          return;
        }
        setScanProg(80);
        const d = await descriptorFromVideo(v);
        if (!live) return;
        if (d) {
          clearInterval(timer);
          setScanState('done');
          setScanProg(100);
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
    setScanProg(8);
    setScanState('scanning');
  };
  // Pendaftaran terpandu: 1 tahan (depan) → 2 geser kanan → 3 geser kiri.
  // Arah dikalibrasi runtime (tahap 2 boleh sisi mana pun, tahap 3 wajib lawannya)
  // → kebal mirror kamera & tetap dapat sepasang kiri-kanan.
  type Stage = 'idle' | 'center' | 'right' | 'left' | 'done';
  const [stage, setStage] = useState<Stage>('idle');
  const [stageFrac, setStageFrac] = useState(0); // progres live dalam tahap
  const gst = useRef({ stage: 'idle' as Stage, ok: 0, best: 0, sideSign: 0, descs: [] as number[][], t0: 0 });
  const onEnrollRef = useRef(onEnroll);
  onEnrollRef.current = onEnroll;
  const onDuplicateRef = useRef(onDuplicate);
  onDuplicateRef.current = onDuplicate;
  const startGuided = () => {
    if (!modelsReady) {
      setStatus('tunggu model siap dulu…');
      return;
    }
    warmAudio(); // buka kunci audio (butuh gesture) biar ting tahap bunyi
    gst.current = { stage: 'center', ok: 0, best: 0, sideSign: 0, descs: [], t0: Date.now() };
    setStageFrac(0);
    setStage('center');
  };
  const resetGuided = () => {
    gst.current = { stage: 'idle', ok: 0, best: 0, sideSign: 0, descs: [], t0: 0 };
    setStageFrac(0);
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
      // Ambang melonggar bila user kesulitan >8 dtk di tahap yang sama.
      const relaxed = Date.now() - R.t0 > 8000;
      if (R.stage === 'center') {
        setStatus('Tahap 1/3: TAHAN wajah menghadap depan, jangan bergerak…');
        if (Math.abs(s.yaw) < 0.06) {
          if (++R.ok >= 3) {
            const d = await snap();
            if (d) {
              // Cek duplikat SEJAK tahap 1 — wajah dikenal langsung ditolak,
              // tidak perlu menunggu 3 tahap selesai.
              const dupe = await checkDuplicate(d);
              if (dupe) {
                R.stage = 'idle';
                setStage('idle');
                setStageFrac(0);
                onDuplicateRef.current?.(dupe.memberId);
                return;
              }
              R.descs.push(d);
              tingStage(0); // tahap 1 lolos
              vib(15);
              R.stage = 'right';
              R.ok = 0;
              R.best = 0;
              R.t0 = Date.now();
              setStageFrac(0);
              setStage('right');
            } else {
              setStatus('Gagal merekam — tahan lagi.');
              R.ok = 0;
              setStageFrac(0);
            }
          } else {
            setStageFrac(R.ok / 3);
          }
        } else {
          R.ok = 0;
          setStageFrac(0);
          setStatus('Tahap 1/3: hadap DEPAN dulu (wajahmu miring).');
        }
      } else if (R.stage === 'right') {
        const need = relaxed ? 0.085 : 0.11;
        setStatus('Tahap 2/3: GESER wajah perlahan ke KANAN…');
        if (Math.abs(s.yaw) > need) {
          R.best = Math.max(R.best, Math.abs(s.yaw));
          setStageFrac(Math.min(0.95, R.best / (need * 1.6)));
          if (++R.ok >= 2) {
            const d = await snap();
            if (d) {
              R.descs.push(d);
              tingStage(1); // tahap 2 lolos
              vib(15);
              R.sideSign = Math.sign(s.yaw);
              R.stage = 'left';
              R.ok = 0;
              R.best = 0;
              R.t0 = Date.now();
              setStageFrac(0);
              setStage('left');
            } else {
              setStatus('Gagal merekam — geser lagi.');
              R.ok = 0;
            }
          }
        } else if (Math.abs(s.yaw) > need * 0.6) {
          R.best = Math.max(R.best, Math.abs(s.yaw));
          setStageFrac(Math.min(0.9, R.best / (need * 1.6)));
          R.ok = 0;
          setStatus('Tahap 2/3: dikit lagi ke kanan…');
        } else {
          R.ok = 0;
          setStageFrac(0);
        }
      } else if (R.stage === 'left') {
        const need = relaxed ? 0.07 : 0.09;
        setStatus('Tahap 3/3: GESER wajah perlahan ke KIRI…');
        if (s.yaw * R.sideSign < -need) {
          R.best = Math.max(R.best, Math.abs(s.yaw));
          setStageFrac(Math.min(0.95, R.best / (need * 1.6)));
          if (++R.ok >= 2) {
            const d = await snap();
            if (d) {
              R.descs.push(d);
              tingStage(2); // tahap 3 lolos
              vib([15, 60, 25]);
              R.stage = 'done';
              setStage('done');
              setStageFrac(1);
              setStatus('Semua tahap terekam — menyimpan…');
              onEnrollRef.current(R.descs.slice(0, 3));
            } else {
              setStatus('Gagal merekam — geser lagi.');
              R.ok = 0;
            }
          }
        } else if (s.yaw * R.sideSign < -need * 0.6) {
          R.best = Math.max(R.best, Math.abs(s.yaw));
          setStageFrac(Math.min(0.9, R.best / (need * 1.6)));
          R.ok = 0;
          setStatus('Tahap 3/3: dikit lagi ke kiri…');
        } else {
          R.ok = 0;
          setStageFrac(0);
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
  // Oval hidup: progres + hijau saat sukses. Enroll = tahap + fraksi live.
  const ovalProg = enroll
    ? (stageIdx < 0 ? 8 : Math.min(100, ((stageIdx + (stageIdx < 3 ? stageFrac : 0)) / 3) * 100))
    : scanProg;
  const ovalDone = enroll ? stage === 'done' : scanState === 'done';
  return (
    <div className="camwrap">
      <motion.div
        className="camcard"
        initial={{ opacity: 0, scale: 0.94, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
      >
        <b>{title}</b>
        <div className="camview">
          <video ref={videoRef} playsInline muted autoPlay />
          <svg className="ovalsvg" viewBox="0 0 100 140" preserveAspectRatio="none">
            <ellipse cx="50" cy="60" rx="30" ry="42" className="ovbg" />
            <motion.ellipse
              cx="50" cy="60" rx="30" ry="42"
              className={ovalDone ? 'ovok' : 'ovrun'}
              pathLength={100}
              strokeDasharray="100"
              initial={false}
              animate={{ strokeDashoffset: 100 - ovalProg }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            />
          </svg>
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
          <>
            <div className="stagebar"><i style={{ width: `${(Math.max(0, stageIdx) / 3) * 100}%` }} /></div>
            <div className="steps">
              {['Tahan', 'Kanan', 'Kiri'].map((s, i) => (
                <span key={s} className={stageIdx > i ? 'done' : stageIdx === i ? 'now' : ''}>
                  {stageIdx > i ? <Check size={12} /> : `${i + 1}.`} {s}
                </span>
              ))}
            </div>
          </>
        )}
        {enroll && stage === 'idle' && modelsReady && (
          <div className="coach">
            <span className="cbubble">Tap di sini untuk mulai</span>
            <span className="carrow">▼</span>
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
        {!enroll && onPinLogin && !showPin && (
          <p className="whint dim">kendala wajah?{' '}
            <button className="wlink dim" onClick={() => { setShowPin(true); setPinErr(null); }}>
              masuk via PIN
            </button>
          </p>
        )}
        {!enroll && showPin && (
          <div className="pinform">
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
              <button onClick={() => setShowPin(false)}>Batal</button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

// ---- Drag-drop jadwal mingguan (minggu depan/seterusnya) ----
// Kartu anggota yang bisa di-drag antar kolom hari. Dipakai di dalam
// DndContext (lihat WeekDragBoard) — posisi ditata pakai @dnd-kit/core murni
// (bukan sortable list) karena tujuannya pindah kartu ANTAR kolom, bukan
// reorder dalam 1 list.
function DragMemberCard({ id, nama, warna, foto, disabled }: {
  id: string; nama: string; warna: string; foto: string | null; disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id, disabled });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50 }
    : undefined;
  const firstName = nama.split(' ')[0];
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`dragcard ${isDragging ? 'dragging' : ''}`}
      title={nama}
      {...attributes}
      {...listeners}
    >
      {foto
        ? <img className="ava" src={foto} alt={nama} />
        : <i className="pdot" style={{ background: warna }} />}
      <span>{firstName}</span>
      {!disabled && <GripVertical size={11} className="griphandle" />}
    </div>
  );
}

// Kolom 1 hari — droppable area tempat kartu di-lepas.
function DragDayColumn({ day, abbr, dateNum, isToday, ids, members, disabled }: {
  day: DayKey; abbr: string; dateNum: number; isToday: boolean;
  ids: string[]; members: Member[]; disabled?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: day, disabled });
  return (
    <div ref={setNodeRef} className={`dragcol ${isToday ? 'now' : ''} ${isOver ? 'over' : ''}`}>
      <div className="dragcolhd"><b>{abbr}</b><span>{dateNum}</span></div>
      <div className="dragcolbody">
        {ids.map((id) => {
          const m = members.find((x) => x.id === id);
          return (
            <DragMemberCard
              key={id} id={`${day}::${id}`}
              nama={m?.nama ?? id} warna={m?.warna ?? '#6b7280'} foto={m?.foto ?? null}
              disabled={disabled}
            />
          );
        })}
        {ids.length === 0 && <p className="dragempty">kosong</p>}
      </div>
    </div>
  );
}

// Papan drag-drop 5 kolom (Senin-Jumat) untuk 1 minggu spesifik. State draft
// dikelola di App (dragSchedule) — komponen ini murni UI + DndContext.
function WeekDragBoard({
  weekLoading, dragSchedule, dragDirty, dragSaving, weekOverridden, weekDates, members,
  onMove, onSave, onReset, onClearOverride,
}: {
  weekLoading: boolean; dragSchedule: Record<DayKey, string[]> | null;
  dragDirty: boolean; dragSaving: boolean; weekOverridden: boolean;
  weekDates: string[]; members: Member[];
  onMove: (memberId: string, fromDay: DayKey, toDay: DayKey) => void;
  onSave: () => void; onReset: () => void; onClearOverride: () => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
  );
  const ABBR2 = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum'];
  const today = dateStr(0);

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const [fromDay, memberId] = String(active.id).split('::') as [DayKey, string];
    const toDay = over.id as DayKey;
    onMove(memberId, fromDay, toDay);
  };

  if (weekLoading || !dragSchedule) {
    return <p className="hint">Memuat jadwal minggu ini…</p>;
  }

  const activeMemberId = activeId ? activeId.split('::')[1] : null;
  const activeMember = members.find((m) => m.id === activeMemberId);

  return (
    <div className="dragboard">
      <p className="hint">
        <GripVertical size={12} /> Seret kartu anggota antar hari untuk atur jadwal minggu ini.
        {weekOverridden && <> Minggu ini punya susunan khusus (beda dari jadwal dasar).</>}
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="dragcols">
          {DAYS.map((d, i) => (
            <DragDayColumn
              key={d} day={d} abbr={ABBR2[i]}
              dateNum={new Date(weekDates[i] + 'T00:00').getDate()}
              isToday={weekDates[i] === today}
              ids={dragSchedule[d]} members={members}
              disabled={dragSaving}
            />
          ))}
        </div>
        <DragOverlay>
          {activeMember && (
            <div className="dragcard dragging overlay">
              {activeMember.foto
                ? <img className="ava" src={activeMember.foto} alt={activeMember.nama} />
                : <i className="pdot" style={{ background: activeMember.warna }} />}
              <span>{activeMember.nama}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
      <div className="dragactions">
        <button className="ghostbtn sm" onClick={onReset} disabled={!dragDirty || dragSaving}>Batal</button>
        {weekOverridden && (
          <button className="ghostbtn sm danger" onClick={onClearOverride} disabled={dragSaving}>
            Kembalikan ke dasar
          </button>
        )}
        <button className="primary sm" onClick={onSave} disabled={!dragDirty || dragSaving}>
          {dragSaving ? 'Menyimpan…' : 'Simpan jadwal minggu ini'}
        </button>
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
  const [preview, setPreview] = useState<{ file: string; judul: string; by: string; tanggal: string } | null>(null);
  const [weekEv, setWeekEv] = useState<Record<string, EvidenceRow[]>>({});
  const knownSwaps = useRef<Set<string> | null>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [lapsit, setLapsit] = useState<LapsitRow[]>([]);
  const [lapsitText, setLapsitText] = useState('');
  const [bdOpen, setBdOpen] = useState<Record<number, boolean>>({});
  const [buktiOpen, setBuktiOpen] = useState(true);
  const [bdDone, setBdDone] = useState<string[]>([]);
  const [nilaiHariIni, setNilaiHariIni] = useState<number | null>(null);
  const [faces, setFaces] = useState<FaceSummary[]>([]);
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
  const [regPin, setRegPin] = useState('');
  const [profiling, setProfiling] = useState(false);
  const [showUnknown, setShowUnknown] = useState(false);
  // Hasil identifikasi wajah yang MENUNGGU KONFIRMASI USER sebelum benar-benar
  // login — mencegah kasus salah-kenali (2 wajah mirip di kamera murah) yang
  // langsung login-kan orang ke akun orang lain tanpa sempat dicek.
  const [confirmHit, setConfirmHit] = useState<{ memberId: string; ambiguous: boolean } | null>(null);
  const [navHidden, setNavHidden] = useState(false);
  const [showLogout, setShowLogout] = useState(false);
  const [pinNew, setPinNew] = useState('');
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Foto profil OPSIONAL (avatar) — file dipilih manual dari galeri/kamera,
  // BUKAN dari proses scan wajah biometrik. Dikompres dulu spy hemat data.
  const onAvatarFile = async (f: File | undefined) => {
    if (!f || !me) return;
    setAvatarBusy(true);
    try {
      const dataUrl = await compressPhoto(f);
      const res = await setProfilePhoto(me, dataUrl);
      if (res.ok) {
        await refresh();
        setToast({ msg: 'Foto profil diperbarui', kind: 'ok' });
      } else {
        setToast({ msg: res.error ?? 'Gagal ganti foto', kind: 'error' });
      }
    } catch {
      setToast({ msg: 'Gagal baca foto', kind: 'error' });
    } finally {
      setAvatarBusy(false);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  };
  const removeAvatar = async () => {
    if (!me) return;
    setAvatarBusy(true);
    const res = await setProfilePhoto(me, '');
    setAvatarBusy(false);
    if (res.ok) { await refresh(); setToast({ msg: 'Foto profil dihapus', kind: 'ok' }); }
  };

  const pinLogin = async (pin: string) => {
    const r = await loginPin(pin);
    if (r.ok && r.memberId) {
      setMe(r.memberId);
      setToast({ msg: `Login berhasil — selamat datang, ${r.nama}`, kind: 'ok' });
      void ensurePush(r.memberId);
      try { sessionStorage.setItem(unlockKey(r.memberId), dateStr(0)); } catch { /* abaikan */ }
      setUnlocked(true);
    }
    return r;
  };

  const savePin = async () => {
    if (!me) return;
    const r = await setLoginPin(me, pinNew);
    setPinMsg(r.ok ? 'PIN tersimpan ✓' : (r.error ?? 'Gagal simpan.'));
    if (r.ok) setPinNew('');
  };
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
  // ---- Mingguan minggu depan/seterusnya: override per-minggu (drag-drop) ----
  const [weekSchedule, setWeekSchedule] = useState<Record<DayKey, string[]> | null>(null);
  const [weekJamRow, setWeekJamRow] = useState<Record<DayKey, string>>({} as Record<DayKey, string>);
  const [weekOverridden, setWeekOverridden] = useState(false);
  const [weekLoading, setWeekLoading] = useState(false);
  const [dragSchedule, setDragSchedule] = useState<Record<DayKey, string[]> | null>(null);
  const [dragDirty, setDragDirty] = useState(false);
  const [dragSaving, setDragSaving] = useState(false);

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
    const c = s.fromApi && me ? await loadChecks(dateStr(0), me) : null;
    setChecks(c ?? localChecks());
    const e = s.fromApi ? await loadEvidence(dateStr(0), dateStr(0), admin ? undefined : me || undefined) : null;
    setEv(e ?? []);
    setBdDone(
      s.fromApi && me ? await loadBreakdown(dateStr(0), me) : load<string[]>(`piket-bd-${dateStr(0)}-${me}`, []),
    );
    setNilaiHariIni(s.fromApi && me ? await loadNilaiToday(dateStr(0), me) : null);
    if (s.fromApi) {
      setFaces(admin ? await loadFaceSummary() : []);
      const a = await loadAttendance(dateStr(0), dateStr(0));
      setAtt(a ?? []);
      setLapsit((await loadLapsit(dateStr(0), dateStr(0), admin ? undefined : me || undefined)) ?? []);
      // Notifikasi pengajuan tukar baru (untuk yang diminta / Admin).
      const pend = s.swaps.filter((x) => x.status === 'pending');
      if (knownSwaps.current) {
        const fresh = pend.filter((x) => !knownSwaps.current!.has(x.id));
        const nm = (id: string) => s.members.find((m) => m.id === id)?.nama ?? id;
        const mine = fresh.filter((x) => x.target === me);
        const forAdmin = admin ? fresh.filter((x) => x.target !== me) : [];
        const show = [...mine, ...forAdmin];
        if (show.length > 0) {
          const w = show[0];
          const msg = `Tukar baru: ${nm(w.requester)} → ${nm(w.target)} (${w.fromDay} ⇄ ${w.toDay})`;
          setToast({ msg, kind: 'info' });
          if ('Notification' in window && Notification.permission === 'granted') {
            try { new Notification('Piket — tukar jadwal', { body: msg }); } catch { /* abaikan */ }
          }
        }
      }
      knownSwaps.current = new Set(s.swaps.map((x) => x.id));
    } else {
      setFaces([]);
      setAtt([]);
      setLapsit([]);
    }
    setUnlocked(me !== '' && sessionStorage.getItem(unlockKey(me)) === dateStr(0));
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
  // Lapsit cuma boleh dikirim 30 menit sebelum jam selesai piket HARI INI.
  // Estimasi tampilan pakai jadwal template (state.jam) — kalau admin
  // override jam khusus minggu ini via drag-drop, validasi FINAL tetap di
  // server (endpoint akan tolak dgn pesan jelas kalau estimasi ini meleset).
  const jamSelesaiHariIni = jamHari ? jamHari.split('–')[1] ?? '' : '';
  const lapsitOpenAt = (() => {
    if (!jamSelesaiHariIni) return '';
    const [hh, mm] = jamSelesaiHariIni.split('.').map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return '';
    const t = new Date(); t.setHours(hh, mm - 30, 0, 0);
    return `${String(t.getHours()).padStart(2, '0')}.${String(t.getMinutes()).padStart(2, '0')}`;
  })();
  const lapsitOpen = (() => {
    if (!jamSelesaiHariIni) return true; // gak ada jadwal jam → jangan block
    const [hh, mm] = jamSelesaiHariIni.split('.').map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return true;
    const batas = new Date(); batas.setHours(hh, mm - 30, 0, 0);
    return new Date() >= batas;
  })();
  const doneCount = checks.filter((c) => c.done).length;
  const pending = (state?.swaps ?? []).filter((s) => s.status === 'pending');
  const incoming = pending.filter((s) => s.target === me);
  const outgoing = pending.filter((s) => s.requester === me);
  const othersPending = pending.filter((s) => s.target !== me && s.requester !== me);
  const approvedSwaps = useMemo(() => (state?.swaps ?? [])
    .filter((s) => s.status === 'approved')
    .sort((a, b) => b.createdAt - a.createdAt), [state]);
  const swappedDays = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86400000;
    const set = new Set<DayKey>();
    for (const s of approvedSwaps) {
      if (s.createdAt >= weekAgo) {
        set.add(s.fromDay);
        set.add(s.toDay);
      }
    }
    return set;
  }, [approvedSwaps]);
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
      const evRows = state?.fromApi && admin ? await loadEvidence(weekDates[0], weekDates[4]) : null;
      const lapRows = state?.fromApi && admin ? await loadLapsit(weekDates[0], weekDates[4]) : null;
      if (live) {
        const grouped: Record<string, EvidenceRow[]> = {};
        for (const e of evRows ?? []) {
          (grouped[e.tanggal] ??= []).push(e);
        }
        setWeekEv(grouped);
      }
      if (!admin) { if (live) setWeekStat({}); return; } // non-admin: rekap tim tidak dibuka (privasi per-orang)
      await Promise.all(weekDates.map(async (ds, i) => {
        const dayKey = DAYS[i]; // weekDates disusun Senin..Jumat, selaras index DAYS
        const dayCrew = state?.schedule[dayKey] ?? [];
        if (dayCrew.length === 0) return;
        // SEMUA anggota yang piket hari itu wajib lengkap sendiri-sendiri
        // (checklist + foto miliknya) — bukan cukup salah satu orang saja.
        const memberDone = await Promise.all(dayCrew.map(async (mid) => {
          const rows = state?.fromApi ? await loadChecks(ds, mid) : localChecks(ds);
          const tasksDone = !!rows?.length && rows.every((r) => r.done);
          if (!tasksDone) return false;
          if (!state?.fromApi || !evRows) return tasksDone;
          const titles = (rows ?? []).map((r) => r.judul);
          const evOk = titles.length > 0 && titles.every((t) =>
            evRows.some((e) => e.tanggal === ds && e.tugas === t && e.memberId === mid));
          const lapOk = !lapRows || lapRows.some((l) => l.tanggal === ds && l.memberId === mid);
          return evOk && lapOk;
        }));
        if (memberDone.every(Boolean)) out[ds] = true;
      }));
      if (live) setWeekStat(out);
    })();
    return () => { live = false; };
  }, [tab, weekOff, state?.fromApi]);

  // Minggu depan & seterusnya (weekOff !== 0): jadwal bisa beda dari template,
  // di-drag-drop terpisah per minggu (lihat db/roster.weekStart + /api/roster/week).
  // Minggu berjalan (weekOff === 0) tetap ikut template dasar seperti sebelumnya.
  useEffect(() => {
    if (tab !== 'minggu' || weekOff === 0 || !state?.fromApi) {
      setWeekSchedule(null);
      setDragSchedule(null);
      setDragDirty(false);
      return;
    }
    let live = true;
    setWeekLoading(true);
    (async () => {
      const w = await loadWeekRoster(weekDates[0]);
      if (!live) return;
      setWeekLoading(false);
      if (!w) return;
      setWeekSchedule(w.schedule);
      setWeekJamRow(w.jam);
      setWeekOverridden(w.overridden);
      setDragSchedule(w.schedule);
      setDragDirty(false);
    })();
    return () => { live = false; };
  }, [tab, weekOff, weekDates, state?.fromApi]);


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
        const [c, e] = await Promise.all([loadChecks(dateStr(0), me), loadEvidence(dateStr(0), dateStr(0), admin ? undefined : me || undefined)]);
        if (c) setChecks(c);
        if (e) setEv(e);
        if (me) setNilaiHariIni(await loadNilaiToday(dateStr(0), me));
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
      const willDo = !prev.includes(key);
      const next = willDo ? [...prev, key] : prev.filter((k) => k !== key);
      if (state?.fromApi && me) {
        void toggleBreakdown(dateStr(0), me, key, willDo).then(() => {
          void loadNilaiToday(dateStr(0), me).then(setNilaiHariIni);
        });
      } else {
        save(`piket-bd-${dateStr(0)}-${me}`, next);
      }
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
    const rows = await loadLapsit(dateStr(0), dateStr(0), admin ? undefined : me || undefined);
    if (rows) setLapsit(rows);
    if (me) setNilaiHariIni(await loadNilaiToday(dateStr(0), me));
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
    void dropPush();
    try { if (me) sessionStorage.removeItem(unlockKey(me)); } catch { /* abaikan */ }
    setMe('');
    setUnlocked(false);
    setShowLogout(false);
  };

  const onProfileDone = (p: Profile) => {
    setRegName(p.nama);
    setRegAngkatan(p.angkatan);
    setRegJabatan(p.jabatan);
    setRegPin(p.pin);
    setProfiling(false);
    warmAudio();
    setCamMsg('Tap Mulai, ikuti tahap: tahan – kanan – kiri');
    setCam({ mode: 'register' });
  };

  // Duplikat ketahuan di tahap 1 → tolak cepat tanpa menunggu 3 tahap.
  const handleDuplicate = (memberId: string) => {
    const msg = `Wajah ini sudah terdaftar sebagai ${nama(memberId)} — pakai Masuk, jangan daftar lagi.`;
    setCamMsg(msg);
    setToast({ msg, kind: 'error' });
  };

  const handleEnroll = async (ds: number[][]) => {
    const parsed = profileSchema.safeParse({ nama: regName, angkatan: regAngkatan, jabatan: regJabatan, pin: regPin });
    if (!parsed.success) {
      setCamMsg(parsed.error.issues[0]?.message ?? 'Profil invalid.');
      return;
    }
    // Tolak wajah yang sudah terdaftar (nama beda pun tetap ketahuan) — cek
    // di SERVER, bukan bandingkan array embedding di browser.
    for (const d of ds) {
      const dupe = await matchFace(d);
      if (dupe) {
        const msg = `Wajah ini sudah terdaftar sebagai ${nama(dupe.memberId)} — pakai Masuk, jangan daftar lagi.`;
        setCamMsg(msg);
        setToast({ msg, kind: 'error' });
        return;
      }
    }
    const res = await registerMember(parsed.data.nama, parsed.data.angkatan, parsed.data.jabatan, parsed.data.pin, ds);
    if (res.ok && res.memberId) {
      const hello = `${parsed.data.nama} (${parsed.data.jabatan}, angkatan ${parsed.data.angkatan})`;
      await refresh();
      setMe(res.memberId);
      setUnlocked(true); // wajah baru saja diverifikasi → langsung terbuka
      try { sessionStorage.setItem(unlockKey(res.memberId), dateStr(0)); } catch { /* abaikan */ }
      if (res.memberId) void ensurePush(res.memberId);
      void getGeo().then(setGeo);
      setRegName('');
      setRegAngkatan('');
      setRegJabatan('');
      setRegPin('');
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
    if (cam.mode === 'login') {
      const hit = await matchFace(d);
      if (!hit) {
        setCam(null);
        setCamMsg(null);
        setShowUnknown(true); // wajah baru → suruh daftar dulu
        return;
      }
      // Selalu minta konfirmasi visual eksplisit sebelum benar-benar login —
      // wajah dari kamera murah/cahaya kurang bisa mirip antar 2 orang beda,
      // jadi jangan langsung percaya hasil algoritma tanpa user cek foto.
      setCam(null);
      setCamMsg(null);
      setConfirmHit({ memberId: hit.memberId, ambiguous: !!hit.ambiguous });
      return;
    }
    if (cam.mode !== 'absen') return;
    const hit = await matchFace(d);
    if (!hit) {
      setCamMsg('Wajah tidak dikenal — Daftar dulu ya.');
      return;
    }
    if (hit.memberId !== me || hit.ambiguous) {
      setCamMsg(`Terdeteksi ${nama(hit.memberId)}${hit.ambiguous ? ' (kurang yakin)' : ''}, bukan ${nama(me)} — keluar lalu masuk lagi, atau coba lagi dengan pencahayaan lebih baik.`);
      return;
    }
    await markAttendance(dateStr(0), me);
    const a = await loadAttendance(dateStr(0), dateStr(0));
    if (a) setAtt(a);
    setUnlocked(true);
    try { sessionStorage.setItem(unlockKey(me), dateStr(0)); } catch { /* abaikan */ }
    ting(990, 0.18); // absen lolos
    setToast({ msg: 'Absen berhasil — checklist & bukti terbuka', kind: 'ok' });
    void ensurePush(me);
    void getGeo().then(setGeo); // siapkan koordinat untuk stempel foto
    setCam(null);
    setCamMsg(null);
  };

  // Konfirmasi identitas hasil pindaian wajah sebelum login benar-benar
  // dieksekusi — user melihat foto+nama match lalu tegas menyatakan
  // "ini saya" atau menolaknya (mencegah insiden salah-login akun orang lain).
  const confirmLogin = () => {
    if (!confirmHit) return;
    const hit = confirmHit;
    setConfirmHit(null);
    setMe(hit.memberId);
    setUnlocked(sessionStorage.getItem(unlockKey(hit.memberId)) === dateStr(0));
    ting(990, 0.18); // masuk
    setToast({ msg: `Login berhasil — selamat datang, ${nama(hit.memberId)}`, kind: 'ok' });
    void ensurePush(hit.memberId);
  };
  const rejectLogin = () => {
    setConfirmHit(null);
    setShowUnknown(true); // "bukan saya" → tawarkan daftar / coba lagi
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
      const ok = await decideSwapRemote(w.id, approve, me);
      if (!ok) return alert('Gagal (hanya yang diminta / Admin).');
    } else {
      if (me !== w.target && !admin) return alert('Hanya yang diminta / Admin.');
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

  const cancelSwap = async (w: SwapRow) => {
    if (!confirm('Batalkan pengajuan ini?')) return;
    if (state?.fromApi) {
      const ok = await cancelSwapRemote(w.id, me);
      if (!ok) return alert('Gagal membatalkan.');
    } else {
      save('piket-swaps', load<SwapRow[]>('piket-swaps', []).map((x) =>
        x.id === w.id ? { ...x, status: 'cancelled' as const } : x));
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

  // ---- Drag-drop jadwal minggu depan/seterusnya (weekOff !== 0) ----
  // Pindah 1 anggota dari satu hari ke hari lain di draft lokal (belum tersimpan
  // ke server — user masih bisa cancel). Anggota yang sama tidak boleh dobel di 1 hari.
  const moveWeekMember = (memberId: string, fromDay: DayKey, toDay: DayKey) => {
    if (fromDay === toDay) return;
    setDragSchedule((prev) => {
      if (!prev) return prev;
      if (prev[toDay].includes(memberId)) return prev; // sudah ada di hari tujuan
      return {
        ...prev,
        [fromDay]: prev[fromDay].filter((id) => id !== memberId),
        [toDay]: [...prev[toDay], memberId],
      };
    });
    setDragDirty(true);
  };

  const saveWeekDrag = async () => {
    if (!dragSchedule) return;
    setDragSaving(true);
    const ok = await saveWeekRosterRemote(weekDates[0], dragSchedule, weekJamRow);
    setDragSaving(false);
    if (!ok) return alert('Gagal simpan (server mati / bukan Admin?).');
    setWeekSchedule(dragSchedule);
    setWeekOverridden(true);
    setDragDirty(false);
    setToast({ msg: `Jadwal minggu ${rangeLabel} tersimpan.`, kind: 'ok' });
  };

  const resetWeekDrag = () => {
    if (!weekSchedule) return;
    setDragSchedule(weekSchedule);
    setDragDirty(false);
  };

  // Buang override minggu ini → kembali mengikuti template dasar.
  const clearWeekOverride = async () => {
    if (!confirm(`Hapus susunan khusus minggu ${rangeLabel}? Minggu ini kembali mengikuti jadwal dasar.`)) return;
    const ok = await clearWeekRosterRemote(weekDates[0]);
    if (!ok) return alert('Gagal (bukan Admin?).');
    const w = await loadWeekRoster(weekDates[0]);
    if (w) {
      setWeekSchedule(w.schedule);
      setWeekJamRow(w.jam);
      setWeekOverridden(w.overridden);
      setDragSchedule(w.schedule);
      setDragDirty(false);
    }
    setToast({ msg: `Minggu ${rangeLabel} kembali ke jadwal dasar.`, kind: 'info' });
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
      if (me) void ensurePush(me);
      new Notification('Ki Menwa USB YPKP', {
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
  useEffect(() => {
    // Bottom nav: sembunyi saat scroll turun, muncul saat scroll naik / idle.
    let lastY = window.scrollY;
    let t: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      const y = window.scrollY;
      if (y > lastY + 4 && y > 80) setNavHidden(true);
      else if (y < lastY - 4) setNavHidden(false);
      lastY = y;
      if (t) clearTimeout(t);
      t = setTimeout(() => setNavHidden(false), 1500);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (t) clearTimeout(t);
    };
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
      <div className="phone wide tac">
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
          onEnroll={(ds) => void handleEnroll(ds)}
          onClose={() => { setCam(null); setCamMsg(null); }}
          onRescan={() => setCamMsg(null)}
          onDuplicate={handleDuplicate}
          checkDuplicate={matchFace}
          onPinLogin={async (pin) => {
            const r = await pinLogin(pin);
            if (r.ok) {
              setCam(null);
              setCamMsg(null);
            }
            return r;
          }}
    />
  );

  // Gate: belum masuk → welcome / form profil. Daily page hanya utk yg login.
  if (!meMember) {
    return (
      <div className="phone tac">
        {profiling
          ? <ProfilePage onDone={onProfileDone} onCancel={() => setProfiling(false)} names={members.map((m) => m.nama)} existing={members.map((m) => ({ nama: m.nama, angkatan: m.angkatan }))} />
          : <WelcomePage onTap={loginCam} onRegister={() => setProfiling(true)} />}
        <AnimatePresence>
          {showUnknown && (
            <motion.div
              className="preview" onClick={() => setShowUnknown(false)}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <motion.div
                className="pvcard" onClick={(e) => e.stopPropagation()}
                initial={{ opacity: 0, scale: 0.94, y: 14 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 10 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
              >
                <b>Wajah belum terdaftar</b>
                <span className="hint">Sistem tidak mengenali wajahmu. Silakan daftar terlebih dahulu.</span>
                <div className="row">
                  <button className="primary" onClick={() => { setShowUnknown(false); setProfiling(true); }}>Registrasi</button>
                  <button onClick={() => setShowUnknown(false)}>Tutup</button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {confirmHit && (() => {
            const cand = members.find((m) => m.id === confirmHit.memberId);
            return (
              <motion.div
                className="preview"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <motion.div
                  className="pvcard" onClick={(e) => e.stopPropagation()}
                  initial={{ opacity: 0, scale: 0.94, y: 14 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 10 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                >
                  <b>{confirmHit.ambiguous ? 'Kurang yakin — ini kamu?' : 'Konfirmasi identitas'}</b>
                  <div className="confirmid">
                    {cand?.foto
                      ? <img className="ava lg" src={cand.foto} alt={cand?.nama ?? ''} />
                      : <i className="pdot lg" style={{ background: cand?.warna ?? '#6b7280' }} />}
                    <span>{cand?.nama ?? confirmHit.memberId}</span>
                  </div>
                  <span className="hint">
                    {confirmHit.ambiguous
                      ? 'Wajahmu mirip lebih dari 1 orang terdaftar. Pastikan benar sebelum lanjut — kalau ragu, pilih "Bukan saya" dan coba pindai ulang dengan pencahayaan lebih baik.'
                      : 'Cek foto & nama di atas — ini kamu?'}
                  </span>
                  <div className="row">
                    <button className="primary" onClick={confirmLogin}>Ya, ini saya</button>
                    <button onClick={rejectLogin}>Bukan saya</button>
                  </div>
                </motion.div>
              </motion.div>
            );
          })()}
        </AnimatePresence>
        <AnimatePresence>{camModal}</AnimatePresence>
        <AnimatePresence>
          {toast && <Toast t={toast} onClose={() => setToast(null)} />}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="phone tac">
      <header className="hd">
        {meMember && (
          <button className="hdavatar" onClick={() => setShowLogout(true)} title="profil">
            {meMember.foto
              ? <img src={meMember.foto} alt={meMember.nama} />
              : <i className="pdot" style={{ background: meMember.warna }} />}
          </button>
        )}
        <div onClick={titleTap}>
          <h1>{tabTitle[tab]}</h1>
          <p>Ki Menwa YPKP • {members.length} anggota{state && !state.fromApi ? ' • offline' : ''}</p>
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
      <AnimatePresence>
        {showPin && (
          <motion.div
            className="pinsheet"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
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
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showLogout && meMember && (
          <motion.div
            className="sheetwrap" onClick={() => setShowLogout(false)}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="sheet" onClick={(e) => e.stopPropagation()}
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'tween', duration: 0.28, ease: 'easeOut' }}
              drag="y" dragConstraints={{ top: 0, bottom: 0 }} dragElastic={0.25}
              onDragEnd={(_, info) => {
                if (info.offset.y > 90 || info.velocity.y > 500) setShowLogout(false);
              }}
            >
              <i className="grabber" />
              {meMember.foto
                ? <img className="sheetava" src={meMember.foto} alt={meMember.nama} />
                : <i className="pdot big" style={{ background: meMember.warna }} />}
              <input
                ref={avatarInputRef} type="file" accept="image/*" hidden
                onChange={(e) => void onAvatarFile(e.target.files?.[0])}
              />
              <div className="avatarrow">
                <button className="ghostbtn sm" disabled={avatarBusy} onClick={() => avatarInputRef.current?.click()}>
                  {avatarBusy ? 'memproses…' : meMember.foto ? 'Ganti foto profil' : 'Tambah foto profil'}
                </button>
                {meMember.foto && (
                  <button className="ghostbtn sm" disabled={avatarBusy} onClick={() => void removeAvatar()}>Hapus foto</button>
                )}
              </div>
              <b>{meMember.nama}</b>
              <span className="hint">{[meMember.jabatan, meMember.angkatan].filter(Boolean).join(' · ')}</span>
              <div className="pinrow">
                <input
                  type="password" inputMode="numeric" maxLength={12}
                  placeholder="PIN baru (min 6 digit)" value={pinNew}
                  onChange={(e) => { setPinNew(e.target.value.replace(/\D/g, '').slice(0, 12)); setPinMsg(null); }}
                />
                <button onClick={savePin}>Simpan PIN</button>
                {pinMsg && <span className="pinmsg">{pinMsg}</span>}
              </div>
              <button className="danger" onClick={logout}>Logout</button>
              <button className="ghostbtn" onClick={() => setShowLogout(false)}>Batal</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main>
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
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
                <div className="bdgroup">
                  <button className="bdhead" onClick={() => setBuktiOpen((o) => !o)}>
                    <span>Bukti Piket (Wajib)</span>
                    <em>{ev.length}/{checks.length}</em>
                    <ChevronDown size={16} className={buktiOpen ? 'rot' : ''} />
                  </button>
                  <AnimatePresence initial={false}>
                    {buktiOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: 'easeOut' }}
                        style={{ overflow: 'hidden' }}
                      >
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
                                    if (ph) setPreview({ file: ph.file, judul: c.judul, by: nama(ph.memberId), tanggal: dateStr(0) });
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
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <h2>Rincian Tugas (Opsional)</h2>
                <p className="hint">
                  Tercatat di server, ikut menentukan nilai piketmu.
                  {nilaiHariIni != null && <> Nilai hari ini: <b>{nilaiHariIni}</b>/100.</>}
                </p>
                {BREAKDOWN.map((g, gi) => {
                  const done = g.items.filter((_, ii) => bdDone.includes(`${gi}:${ii}`)).length;
                  const open = !!bdOpen[gi];
                  return (
                    <div key={gi} className="bdgroup">
                      <button className="bdhead" onClick={() => setBdOpen((o) => ({ ...o, [gi]: !o[gi] }))}>
                        <span>{gi + 1}. {g.title}</span>
                        <em>{done}/{g.items.length}</em>
                        <ChevronDown size={16} className={open ? 'rot' : ''} />
                      </button>
                      {open && (
                        <AnimatePresence initial={false}>
                          <motion.ul
                            className="tasks"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.22, ease: 'easeOut' }}
                            style={{ overflow: 'hidden' }}
                          >
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
                          </motion.ul>
                        </AnimatePresence>
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
                      disabled={!unlocked || ev.length < checks.length || checks.length === 0 || !lapsitOpen}
                      onClick={kirimLapsit}
                    >
                      Kirim lapsit akhir piket
                    </button>
                    {unlocked && (ev.length < checks.length) && (
                      <p className="hint">Lengkapi {checks.length} foto bukti dulu.</p>
                    )}
                    {unlocked && ev.length >= checks.length && checks.length > 0 && !lapsitOpen && (
                      <p className="hint">Lapsit bisa dikirim mulai {lapsitOpenAt} (30 menit sebelum piket selesai jam {jamSelesaiHariIni}).</p>
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
            {admin && weekOff !== 0 ? (
              <WeekDragBoard
                weekLoading={weekLoading}
                dragSchedule={dragSchedule}
                dragDirty={dragDirty}
                dragSaving={dragSaving}
                weekOverridden={weekOverridden}
                weekDates={weekDates}
                members={members}
                onMove={moveWeekMember}
                onSave={saveWeekDrag}
                onReset={resetWeekDrag}
                onClearOverride={clearWeekOverride}
              />
            ) : (
              DAYS.map((d, i) => {
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
                      {(weekEv[ds] ?? []).length > 0 && (
                        <span className="dayph">
                          {(weekEv[ds] ?? []).map((e) => (
                            <img
                              key={e.id} src={e.file} alt={e.tugas}
                              onClick={() => setPreview({ file: e.file, judul: e.tugas, by: nama(e.memberId), tanggal: ds })}
                            />
                          ))}
                        </span>
                      )}
                    </div>
                    {swappedDays.has(d) && <em className="swapmark" title="hari ini hasil tukar jadwal"><ArrowLeftRight size={12} /></em>}
                    {isToday
                      ? <em className="pill sm">hari ini</em>
                      : weekStat[ds]
                        ? <em className="badge-ok"><Check size={11} /> selesai</em>
                        : <em className="badge-idle" />}
                  </div>
                );
              })
            )}
            {approvedSwaps.length > 0 && (
              <div className="swaplog">
                <b>Hasil tukar jadwal</b>
                {approvedSwaps.slice(0, 5).map((s) => (
                  <p key={s.id} className="hist">
                    {nama(s.requester)} <ArrowLeftRight size={11} /> {nama(s.target)} • {s.fromDay} <ArrowLeftRight size={11} /> {s.toDay}
                  </p>
                ))}
              </div>
            )}
            {admin && <button className="rotbtn" onClick={putarRotasi}><Repeat size={14} /> Putar rotasi minggu depan (Admin)</button>}
            {admin && (
              <>
                <h2 className="sec">Anggota terdaftar ({members.length})</h2>
                {!state?.fromApi
                  ? <p className="hint">Butuh online untuk lihat pendaftar.</p>
                  : members.length === 0
                    ? <p className="hint">Belum ada yang daftar — suruh buka tab Hari Ini → Daftar.</p>
                    : members.map((m) => {
                      const n = faces.find((f) => f.memberId === m.id)?.count ?? 0;
                      return (
                        <div key={m.id} className="facerow">
                          {m.foto
                            ? <img className="ava" src={m.foto} alt={m.nama} />
                            : <i style={{ background: m.warna }} />}
                          <span>{m.nama}{m.jabatan ? ` · ${m.jabatan}` : ''}{m.angkatan ? ` ${m.angkatan}` : ''}</span>
                          {isOnline(m) && <i className="onlinedot" title="online" />}
                          <em className={n ? 'badge-ok' : 'badge-no'}>{n ? <>wajah <Check size={11} /></> : 'tanpa wajah'}</em>
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
            {incoming.map((w) => (
              <div key={w.id} className="waitcard">
                <i className="pdot" style={{ background: warna(w.requester) }} />
                <span>{nama(w.requester)} meminta tukar<br />{dayDate(w.fromDay)} <ArrowLeftRight size={12} /> {dayDate(w.toDay)}</span>
              </div>
            ))}
            {incoming.length > 0 && (
              <div className="row waitrow">
                <button className="primary" onClick={() => decide(incoming[0], true)}>Terima</button>
                <button onClick={() => decide(incoming[0], false)}>Tolak</button>
              </div>
            )}
            {outgoing.map((w) => (
              <div key={w.id} className="waitcard">
                <i className="pdot" style={{ background: warna(w.target) }} />
                <span>Ke {nama(w.target)}<br />{dayDate(w.fromDay)} <ArrowLeftRight size={12} /> {dayDate(w.toDay)} • menunggu</span>
                <button className="ketua" onClick={() => cancelSwap(w)}>batalkan</button>
              </div>
            ))}
            {admin && othersPending.length > 0 && (
              <>
                <h2 className="sec">Antrean lain (Admin override)</h2>
                {othersPending.map((w) => (
                  <div key={w.id}>
                    <div className="waitcard">
                      <i className="pdot" style={{ background: warna(w.requester) }} />
                      <span>{nama(w.requester)} → {nama(w.target)}<br />{dayDate(w.fromDay)} <ArrowLeftRight size={12} /> {dayDate(w.toDay)}</span>
                      <button className="ketua" onClick={() => setExpanded(expanded === w.id ? null : w.id)}>aksi Admin</button>
                    </div>
                    {expanded === w.id && (
                      <div className="row waitrow">
                        <button className="primary" onClick={() => { setExpanded(null); decide(w, true); }}>Approve</button>
                        <button onClick={() => { setExpanded(null); decide(w, false); }}>Tolak</button>
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
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
          </motion.div>
        </AnimatePresence>
      </main>

      {tab === 'hari' && checks.length > 0 && (
        <div className="progress"><i style={{ width: `${(doneCount / checks.length) * 100}%` }} /></div>
      )}
      <AnimatePresence>{camModal}</AnimatePresence>
      <AnimatePresence>
        {toast && <Toast t={toast} onClose={() => setToast(null)} />}
      </AnimatePresence>
      <AnimatePresence>
        {preview && (
          <motion.div
            className="preview" onClick={() => setPreview(null)}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="pvcard" onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.94, y: 14 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
            >
              <div className="wmwrap">
                <img src={preview.file} alt={preview.judul} />
                {admin && preview.by !== nama(me ?? '') && (
                  <span className="wm">{nama(me ?? '') || 'Admin'} • {new Date().toLocaleString('id-ID')}</span>
                )}
              </div>
              <b>{preview.judul}</b>
              <span className="hint">oleh {preview.by} • {preview.tanggal.split('-').reverse().join('/')} • final, tidak bisa diubah</span>
              <div className="row">
                <button className="primary" onClick={() => setPreview(null)}>Tutup</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <motion.nav
        className="tabs"
        initial={false}
        animate={{ x: '-50%', y: navHidden ? '110%' : '0%' }}
        transition={{ type: 'tween', duration: 0.3, ease: 'easeOut' }}
      >
        <button className={tab === 'hari' ? 'on' : ''} onClick={() => setTab('hari')}><CalendarDays size={20} /><span>Hari Ini</span></button>
        <button className={tab === 'minggu' ? 'on' : ''} onClick={() => setTab('minggu')}><CalendarRange size={20} /><span>Mingguan</span></button>
        <button className={tab === 'tukar' ? 'on' : ''} onClick={() => setTab('tukar')}><ArrowLeftRight size={20} /><span>Tukar{pending.length ? ` (${pending.length})` : ''}</span></button>
      </motion.nav>
    </div>
  );
}
