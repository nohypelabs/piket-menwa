import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, RotateCw, ScanFace } from 'lucide-react';
import { descriptorFromVideo, ensureModels, getFaceApi, tingStage, warmAudio, yawFromVideo } from '../face';

// Modal kamera selfie: sekali-ambil (verifikasi/absen) atau burst (daftar).
export function FaceCam({ title, note, enroll, onShot, onEnroll, onClose, onRescan, onDuplicate, onPinLogin, checkDuplicate }: {
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
