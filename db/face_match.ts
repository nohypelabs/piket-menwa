// Port server-side dari src/face.ts identify() — SATU-SATUNYA tempat
// perbandingan embedding wajah dilakukan sekarang. Client cuma kirim 1
// descriptor sample (hasil scan kamera device sendiri) dan terima hasil
// {memberId, ambiguous} — TIDAK PERNAH menerima descriptor milik orang lain.
export interface Enrolled {
  memberId: string;
  descriptors: number[][];
}

const dist = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
};

// Sama persis logika/threshold dgn src/face.ts identify() — jaga tetap sinkron.
export function identify(
  sample: number[],
  enrolled: Enrolled[],
  threshold = 0.48,
  minMargin = 0.07,
): { memberId: string; distance: number; ambiguous?: boolean } | null {
  let best: { memberId: string; distance: number } | null = null;
  let secondBestOther = Infinity;
  for (const e of enrolled) {
    for (const d of e.descriptors) {
      if (d.length !== sample.length) continue;
      const x = dist(sample, d);
      if (!best || x < best.distance) {
        if (best && best.memberId !== e.memberId) secondBestOther = Math.min(secondBestOther, best.distance);
        best = { memberId: e.memberId, distance: x };
      } else if (e.memberId !== best.memberId) {
        secondBestOther = Math.min(secondBestOther, x);
      }
    }
  }
  if (!best || best.distance > threshold) return null;
  if (secondBestOther - best.distance < minMargin) {
    return { memberId: best.memberId, distance: best.distance, ambiguous: true };
  }
  return best;
}
