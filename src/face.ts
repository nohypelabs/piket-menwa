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

export interface Enrolled {
  memberId: string;
  descriptors: number[][];
}

export const dist = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
};

// Foto JPEG dari 1 frame video (untuk foto referensi pendaftaran).
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

// Cocokkan 1 wajah ke daftar terdaftar. threshold 0.55 (umum 0.5–0.6).
export function identify(
  sample: number[],
  enrolled: Enrolled[],
  threshold = 0.55,
): { memberId: string; distance: number } | null {
  let best: { memberId: string; distance: number } | null = null;
  for (const e of enrolled) {
    for (const d of e.descriptors) {
      if (d.length !== sample.length) continue;
      const x = dist(sample, d);
      if (!best || x < best.distance) best = { memberId: e.memberId, distance: x };
    }
  }
  return best && best.distance <= threshold ? best : null;
}

// ---- Umpan suara (Web Audio, tanpa file): ting per tahap lolos ----
let audioCtx: AudioContext | null = null;

// Panggil di dalam tap tombol (butuh gesture browser).
export function warmAudio() {
  try {
    audioCtx ??= new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch { /* suara opsional */ }
}

export function ting(freq = 880, dur = 0.15, delay = 0) {
  try {
    warmAudio();
    if (!audioCtx || audioCtx.state !== 'running') return;
    const t = audioCtx.currentTime + delay;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  } catch { /* suara opsional */ }
}

// Nada naik per tahap pendaftaran: tahan → kanan → kiri.
export const tingStage = (n: number) => ting([660, 880, 1170][n] ?? 880, 0.18);
