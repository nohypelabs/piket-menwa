// Face recognition 100% lokal: lib (public/libs) + model (public/models)
// di-cache service worker → jalan offline setelah dibuka sekali.
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
type FaceApi = any;

let api: FaceApi | null = null;
let modelsOk = false;

function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-face="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.face = src;
    s.onload = () => res();
    s.onerror = () => rej(new Error('gagal memuat ' + src));
    document.head.appendChild(s);
  });
}

export async function getFaceApi(): Promise<FaceApi> {
  if (api) return api;
  await loadScript('/libs/face-api.js');
  api = (window as unknown as { faceapi: FaceApi }).faceapi;
  if (!api) throw new Error('face-api tidak termuat');
  return api;
}

export async function ensureModels(onStep?: (msg: string) => void): Promise<void> {
  const f = await getFaceApi();
  if (modelsOk) return;
  const steps: [string, string][] = [
    ['model deteksi wajah 1/3…', 'tinyFaceDetector'],
    ['model landmark 2/3…', 'faceLandmark68Net'],
    ['model pengenal 3/3 (~6MB)…', 'faceRecognitionNet'],
  ];
  for (const [msg, net] of steps) {
    onStep?.(msg);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await f.nets[net].loadFromUri('/models');
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
  }
  modelsOk = true;
}

// Descriptor 128 angka dari 1 frame video. null = tidak ada wajah terdeteksi.
export async function descriptorFromVideo(video: HTMLVideoElement): Promise<number[] | null> {
  const f = await getFaceApi();
  const det = await f
    .detectSingleFace(video, new f.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!det?.descriptor) return null;
  return Array.from(det.descriptor as Float32Array);
}

// Matching wajah SEKARANG dilakukan di server (lihat db/face_match.ts +
// endpoint POST /api/faces/match) — client tidak pernah menyimpan/membanding
// embedding member lain. Fungsi identify()/dist() versi client DIHAPUS
// sengaja supaya tidak ada jalur pintas yang menggoda dipakai lagi.

// ---- Umpan suara (Web Audio, tanpa file): nada ala HUD sci-fi ----
export function photoFromVideo(video: HTMLVideoElement, maxDim = 640, quality = 0.8): string | null {  try {
    if (!video.videoWidth) return null;
    const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(video.videoWidth * scale);
    c.height = Math.round(video.videoHeight * scale);
    c.getContext('2d')?.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  }
}

export interface YawSample {
  yaw: number; // + = satu sisi, − = sisi lawan (tanda dikalibrasi runtime)
  faceRatio: number; // lebar wajah / lebar frame
}

// Arah hadap dari geometri landmark (ujung hidung vs tengah kedua mata),
// dinormalisasi lebar wajah → kebal geser posisi & tidak peduli rambut/botak.
export async function yawFromVideo(video: HTMLVideoElement): Promise<YawSample | null> {
  const f = await getFaceApi();
  const det = await f
    .detectSingleFace(video, new f.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
    .withFaceLandmarks();
  if (!det?.landmarks) return null;
  const lm = det.landmarks;
  const mid = (pts: { x: number; y: number }[]) => ({
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  });
  const ec = mid([mid(lm.getLeftEye()), mid(lm.getRightEye())]);
  const noseTip = lm.getNose()[3]; // landmark 30
  const w = det.detection.box.width;
  if (!w || !video.videoWidth) return null;
  return { yaw: (noseTip.x - ec.x) / w, faceRatio: w / video.videoWidth };
}
// tanpa simpan video. Fallback: kembalikan apa adanya bila < k.
const dist = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
};

export function selectDiverse(samples: number[][], k = 3): number[][] {
  if (samples.length <= k) return samples;
  const picked: number[][] = [samples[0]];
  while (picked.length < k) {
    let best: number[] | null = null;
    let bestD = -1;
    for (const s of samples) {
      if (picked.includes(s)) continue;
      const m = Math.min(...picked.map((p) => dist(p, s)));
      if (m > bestD) {
        bestD = m;
        best = s;
      }
    }
    if (!best) break;
    picked.push(best);
  }
  return picked;
}

// Matching wajah SEKARANG dilakukan di server (lihat db/face_match.ts +
// endpoint POST /api/faces/match) — client tidak pernah menyimpan/membanding
// embedding member lain. Fungsi identify() versi client DIHAPUS sengaja
// supaya tidak ada jalur pintas yang menggoda dipakai lagi (dulu di sini,
// dipindah ke server persis sama threshold/margin-nya).

// ---- Umpan suara (Web Audio, tanpa file): nada ala HUD sci-fi ----
let audioCtx: AudioContext | null = null;

// Panggil di dalam tap tombol (butuh gesture browser).
export function warmAudio() {
  try {
    audioCtx ??= new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch { /* suara opsional */ }
}

interface ToneOpts {
  type?: OscillatorType;
  peak?: number;
  detune?: number;
  filterFreq?: number;
  filterQ?: number;
}

// Nada dasar + amplop cepat (attack pendek, decay eksponensial) — building
// block untuk lapisan-lapisan suara di bawah.
function tone(ctx: AudioContext, t0: number, freq: number, dur: number, opts: ToneOpts = {}) {
  const { type = 'sine', peak = 0.4, detune = 0, filterFreq, filterQ = 1 } = opts;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  o.detune.value = detune;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, dur * 0.25));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  if (filterFreq) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(filterFreq, t0);
    f.Q.value = filterQ;
    o.connect(f);
    f.connect(g);
  } else {
    o.connect(g);
  }
  g.connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

// Sapuan frekuensi naik cepat lewat lowpass yang ikut menyapu — kesan
// "scan"/"lock-on" radar ala antarmuka sci-fi, bukan sinus polos.
function chirp(ctx: AudioContext, t0: number, fromFreq: number, toFreq: number, dur: number, peak = 0.28) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const f = ctx.createBiquadFilter();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(fromFreq, t0);
  o.frequency.exponentialRampToValueAtTime(toFreq, t0 + dur);
  f.type = 'lowpass';
  f.frequency.setValueAtTime(fromFreq * 2, t0);
  f.frequency.exponentialRampToValueAtTime(toFreq * 2.2, t0 + dur);
  f.Q.value = 0.8;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(f);
  f.connect(g);
  g.connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

// Login/absen/verifikasi wajah berhasil — "akses diterima": chirp naik
// cepat + dua nada harmonis interval kwint (sedikit di-detune biar berasa
// digital, bukan organ), ditutup shimmer tinggi pendek. Signature dipakai
// apa adanya di App.tsx (ting(990, 0.18)).
export function ting(freq = 880, dur = 0.15, delay = 0) {
  try {
    warmAudio();
    if (!audioCtx || audioCtx.state !== 'running') return;
    const ctx = audioCtx;
    const t0 = ctx.currentTime + delay;
    chirp(ctx, t0, freq * 0.6, freq * 1.05, dur * 0.45, 0.22);
    tone(ctx, t0 + dur * 0.15, freq, dur * 0.6, { type: 'triangle', peak: 0.32 });
    tone(ctx, t0 + dur * 0.32, freq * 1.5, dur * 0.55, { type: 'sine', peak: 0.24, detune: 4 });
    tone(ctx, t0 + dur * 0.32, freq * 1.5, dur * 0.5, { type: 'sine', peak: 0.12, detune: -4 });
    tone(ctx, t0 + dur * 0.5, freq * 3, dur * 0.25, { type: 'sine', peak: 0.06 }); // shimmer
  } catch { /* suara opsional */ }
}

// Nada per tahap pendaftaran wajah (tahan → kanan → kiri): tiap tahap
// lolos terasa seperti radar lock-on — sapuan cepat + ping pendek, nada
// makin tinggi tiap tahap biar progres kerasa.
export const tingStage = (n: number) => {
  try {
    warmAudio();
    if (!audioCtx || audioCtx.state !== 'running') return;
    const ctx = audioCtx;
    const t0 = ctx.currentTime;
    const base = [660, 880, 1175][n] ?? 880;
    chirp(ctx, t0, base * 0.7, base * 1.15, 0.09, 0.22);
    tone(ctx, t0 + 0.05, base, 0.14, { type: 'triangle', peak: 0.26, filterFreq: base * 3 });
    tone(ctx, t0 + 0.05, base * 2, 0.1, { type: 'sine', peak: 0.08 });
  } catch { /* suara opsional */ }
};
