import { db, BUKTI_TEMPLATE } from '../db/client.ts';
import { tasks } from '../db/schema.sqlite.ts';

// Seed awal: template bukti wajib. Anggota mulai KOSONG —
// masing-masing daftar mandiri via wajah + profil, Admin yang susun roster.
if (db.select().from(tasks).all().length === 0) {
  BUKTI_TEMPLATE.forEach((judul, i) => {
    db.insert(tasks).values({ tanggal: 'template', judul, done: 0, sort: i }).run();
  });
}
console.log('seed ok: template bukti piket (anggota kosong, daftar mandiri via wajah)');
