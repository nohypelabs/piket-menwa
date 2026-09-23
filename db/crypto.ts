// Enkripsi embedding wajah at-rest (AES-256-GCM). Prinsip: kalau DB bocor,
// yang didapat penyerang cuma ciphertext acak — bukan vektor wajah yang bisa
// dipakai reverse-match atau replay ke sistem lain.
//
// Key sekarang dari env var FACE_ENC_KEY (base64, 32 byte) — sementara
// sampai project pindah ke Supabase (rencana pakai Supabase Vault / KMS
// beneran untuk envelope encryption penuh). Untuk sekarang minimal DEV wajib
// generate key (bukan hardcode), key TIDAK boleh masuk git.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

function loadKey(): Buffer {
  const b64 = process.env.FACE_ENC_KEY;
  if (b64) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 32) return buf;
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: FACE_ENC_KEY wajib base64 32 byte di production — server tidak dijalankan.');
    process.exit(1);
  }
  console.warn('⚠️  FACE_ENC_KEY belum valid — pakai key acak SEMENTARA (data embedding hilang saat restart). Jangan deploy begini!');
  return randomBytes(32); // fallback dev-only, tidak persisten antar-restart
}

const KEY = loadKey();

// Format ciphertext: base64(iv(12) || authTag(16) || ciphertext)
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const pt = Buffer.from(JSON.stringify(value), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptJson<T>(blob: string): T {
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as T;
}
