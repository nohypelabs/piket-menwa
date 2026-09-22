// Master 34 tugas penilaian — verbatim dari CARA_PENILAIAN_PIKET_KOMPI_MENWA_revisi.xlsx.
// Total 100 (Wajib 65 + Kondisional 35). Di-snapshot per assessment item.
export interface MasterTugas {
  no: number;
  kategori: string;
  judul: string;
  bobot: number;
  jenis: 'Wajib' | 'Kondisional';
  fotoWajib: boolean;
}

const FOTO_WAJIB_NO = new Set([8, 15, 27, 33]);

const RAW: [number, string, string, number, 'Wajib' | 'Kondisional'][] = [
  [1, 'Persiapan Awal Piket', 'Hadir sesuai jadwal piket', 3, 'Wajib'],
  [2, 'Persiapan Awal Piket', 'Mengisi daftar kehadiran Online', 1, 'Wajib'],
  [3, 'Persiapan Awal Piket', 'Membuka ruang/Mako Menwa', 3, 'Wajib'],
  [4, 'Persiapan Awal Piket', 'Menyalakan lampu dan perangkat yang diperlukan', 2, 'Wajib'],
  [5, 'Persiapan Awal Piket', 'Memastikan kondisi Mako aman dan bersih', 3, 'Wajib'],
  [6, 'Persiapan Awal Piket', 'Mengecek kunci, pintu, jendela, dan fasilitas', 3, 'Wajib'],
  [7, 'Menjaga Mako Selama Piket', 'Menjaga keamanan dan ketertiban Mako', 3, 'Wajib'],
  [8, 'Menjaga Mako Selama Piket', 'Menjaga kebersihan dan kerapian ruangan', 3, 'Wajib'],
  [9, 'Menjaga Mako Selama Piket', 'Memantau keluar-masuk anggota/tamu', 3, 'Wajib'],
  [10, 'Menjaga Mako Selama Piket', 'Menerima dan mengarahkan tamu yang datang', 2, 'Kondisional'],
  [11, 'Menjaga Mako Selama Piket', 'Tidak meninggalkan Mako tanpa pengganti', 4, 'Wajib'],
  [12, 'Menjaga Mako Selama Piket', 'Menjaga barang dan inventaris Menwa', 3, 'Wajib'],
  [13, 'Menjaga Mako Selama Piket', 'Memastikan penggunaan fasilitas sesuai aturan', 2, 'Wajib'],
  [14, 'Administrasi & Inventaris', 'Memperbarui papan informasi/papan tugas', 4, 'Wajib'],
  [15, 'Administrasi & Inventaris', 'Mengecek inventaris', 4, 'Wajib'],
  [16, 'Administrasi & Inventaris', 'Mencatat barang yang dipinjam/dikembalikan', 2, 'Kondisional'],
  [17, 'Administrasi & Inventaris', 'Mengisi Buku Tamu', 2, 'Kondisional'],
  [18, 'Administrasi & Inventaris', 'Mencatat kejadian penting selama piket', 3, 'Kondisional'],
  [19, 'Administrasi & Inventaris', 'Melaporkan kerusakan atau kehilangan', 2, 'Kondisional'],
  [20, 'Administrasi & Inventaris', 'Menerima Surat Masuk', 3, 'Kondisional'],
  [21, 'Administrasi & Inventaris', 'Mengisi Agenda Surat Masuk', 2, 'Kondisional'],
  [22, 'Administrasi & Inventaris', 'Distribusi Surat', 3, 'Kondisional'],
  [23, 'Kegiatan Selama Piket', 'Membantu kebutuhan kegiatan Menwa yang berlangsung', 5, 'Kondisional'],
  [24, 'Kegiatan Selama Piket', 'Menjaga kesiapan ruangan untuk rapat/kegiatan', 4, 'Kondisional'],
  [25, 'Kegiatan Selama Piket', 'Membantu anggota/pengurus yang membutuhkan informasi', 3, 'Kondisional'],
  [26, 'Kegiatan Selama Piket', 'Menjaga suasana Mako tetap tertib', 3, 'Wajib'],
  [27, 'Penutupan & Serah Terima', 'Membersihkan dan merapikan Mako', 4, 'Wajib'],
  [28, 'Penutupan & Serah Terima', 'Memastikan barang/inventaris kembali pada tempatnya', 4, 'Wajib'],
  [29, 'Penutupan & Serah Terima', 'Mematikan perangkat yang tidak diperlukan', 2, 'Wajib'],
  [30, 'Penutupan & Serah Terima', 'Mengecek pintu, jendela, listrik, dan fasilitas', 3, 'Wajib'],
  [31, 'Penutupan & Serah Terima', 'Memastikan catatan akhir Agenda Surat Masuk & Buku Tamu', 2, 'Kondisional'],
  [32, 'Penutupan & Serah Terima', 'Melakukan serah terima dengan petugas piket berikutnya', 4, 'Wajib'],
  [33, 'Penutupan & Serah Terima', 'Membuat Catatan Lapsit / Logbook', 4, 'Wajib'],
  [34, 'Penutupan & Serah Terima', 'Menyampaikan kejadian/hal penting kepada piket berikutnya', 2, 'Kondisional'],
];

export const NILAI_MASTER: MasterTugas[] = RAW.map(([no, kategori, judul, bobot, jenis]) => ({
  no,
  kategori,
  judul,
  bobot,
  jenis,
  fotoWajib: FOTO_WAJIB_NO.has(no),
}));

// Nilai = Σbobot selesai ÷ (100 − Σbobot N/A) × 100 (2 desimal). null bila penyebut 0.
export function hitungNilai(items: { bobot: number; status: string }[]): number | null {
  let selesai = 0;
  let na = 0;
  for (const it of items) {
    if (it.status === 'selesai') selesai += it.bobot;
    else if (it.status === 'na') na += it.bobot;
  }
  const denom = 100 - na;
  if (denom <= 0) return null;
  return Math.round((selesai / denom) * 100 * 100) / 100;
}
