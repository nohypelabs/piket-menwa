import { db, BUKTI_TEMPLATE } from '../db/client.ts';
import { tasks, tugasMaster } from '../db/schema.sqlite.ts';
import { NILAI_MASTER } from '../db/nilai_master.ts';

// Seed awal: template bukti wajib. Anggota mulai KOSONG —
// masing-masing daftar mandiri via wajah + profil, Admin yang susun roster.
if (db.select().from(tasks).all().length === 0) {
  BUKTI_TEMPLATE.forEach((judul, i) => {
    db.insert(tasks).values({ tanggal: 'template', judul, done: 0, sort: i }).run();
  });
}
console.log('seed ok: template bukti piket (anggota kosong, daftar mandiri via wajah)');

if (db.select().from(tugasMaster).all().length === 0) {
  for (const m of NILAI_MASTER) {
    db.insert(tugasMaster).values({
      no: m.no, kategori: m.kategori, judul: m.judul,
      bobot: m.bobot, jenis: m.jenis, fotoWajib: m.fotoWajib ? 1 : 0,
    }).run();
  }
  console.log(`seed ok: ${NILAI_MASTER.length} master tugas penilaian`);
}
