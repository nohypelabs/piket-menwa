// Stempel tanggal-jam (+koordinat bila ada) dibakar ke pixel foto
// + pembaca geolocation HP.

export interface Geo {
  lat: number;
  lng: number;
  acc: number;
}

export function getGeo(timeoutMs = 8000): Promise<Geo | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy });
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 },
    );
  });
}

const fmtStamp = new Intl.DateTimeFormat('id-ID', {
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

// Kompres + stempel baris waktu (dan koordinat) di bilah bawah foto.
// Output WebP adaptif: kualitas diturunkan dulu (0.8→0.25), kalau masih
// > target baru resolusi dikecilkan bertahap (min 480px). Khusus bukti piket.
const WEBP_MAX_BYTES = 40 * 1024;

const dataUrlBytes = (du: string) => Math.round((du.length - du.indexOf(',') - 1) * 0.75);

// Logo Menwa untuk watermark kanan-atas (dimuat sekali, dilewati bila tidak ada).
let brandLogo: HTMLImageElement | null | undefined;
function loadBrandLogo(): Promise<HTMLImageElement | null> {
  if (brandLogo !== undefined) return Promise.resolve(brandLogo);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { brandLogo = img; resolve(img); };
    img.onerror = () => { brandLogo = null; resolve(null); };
    img.src = '/brand/logo-menwa.png';
  });
}

// Encode adaptif: turunkan kualitas dulu (0.8→0.25), baru kembalikan ukuran.
// Menjamin output WebP ≤ target tanpa merusak dimensi lebih dari perlu.
function encodeFitWebP(c: HTMLCanvasElement, targetBytes = WEBP_MAX_BYTES): string {
  let q = 0.8;
  let out = c.toDataURL('image/webp', q);
  while (dataUrlBytes(out) > targetBytes && q > 0.26) {
    q = Math.round((q - 0.1) * 100) / 100;
    out = c.toDataURL('image/webp', q);
  }
  return out;
}

function drawStamped(img: HTMLImageElement, logo: HTMLImageElement | null, geo: Geo | null, maxDim: number, nama?: string): HTMLCanvasElement {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const lines = [fmtStamp.format(new Date())];
  if (nama) lines.unshift(nama);
  if (geo) lines.push(`${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)} (±${Math.round(geo.acc)}m)`);
  const fs = Math.max(14, Math.round(w * 0.032));
  const lh = Math.round(fs * 1.35);
  const pad = Math.round(fs * 0.7);
  const barH = lines.length * lh + pad * 2;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h + barH;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas gagal');
  ctx.drawImage(img, 0, 0, w, h);
  if (logo && logo.width > 0) {
    // Watermark logo Menwa kanan-atas (±18% lebar foto).
    const lw = Math.round(w * 0.18);
    const lhLogo = Math.round(lw * (logo.height / logo.width));
    const m = Math.round(fs * 0.6);
    ctx.drawImage(logo, w - lw - m, m, lw, lhLogo);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, h, w, barH);
  ctx.fillStyle = '#fff';
  ctx.font = `${fs}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  lines.forEach((ln, i) => ctx.fillText(ln, pad, h + pad + i * lh));
  return c;
}

export function stampPhoto(file: File, geo: Geo | null, maxDim = 1280, nama?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      try {
        const logo = await loadBrandLogo();
        let dim = maxDim;
        let out = '';
        for (;;) {
          out = encodeFitWebP(drawStamped(img, logo, geo, dim, nama));
          if (dataUrlBytes(out) <= WEBP_MAX_BYTES || dim <= 480) break;
          dim = Math.round(dim * 0.85);
        }
        URL.revokeObjectURL(url);
        resolve(out);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('baca foto gagal'));
    };
    img.src = url;
  });
}

// Kompresi polos tanpa stempel apa pun (dipakai utk avatar profil — beda
// dari stampPhoto() yang membakar tanggal/jam/koordinat, itu khusus bukti piket).
// Output SELALU WebP ≤ 40KB (kualitas dulu, baru dimensi, min 240px).
export function compressPhoto(file: File, maxDim = 480): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const draw = (dim: number): HTMLCanvasElement => {
          const scale = Math.min(1, dim / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d');
          if (!ctx) throw new Error('canvas gagal');
          ctx.drawImage(img, 0, 0, w, h);
          return c;
        };
        let dim = maxDim;
        let out = encodeFitWebP(draw(dim));
        while (dataUrlBytes(out) > WEBP_MAX_BYTES && dim > 240) {
          dim = Math.round(dim * 0.85);
          out = encodeFitWebP(draw(dim));
        }
        URL.revokeObjectURL(url);
        resolve(out);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('baca foto gagal'));
    };
    img.src = url;
  });
}
