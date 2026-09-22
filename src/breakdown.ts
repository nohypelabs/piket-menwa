// Rincian tugas harian ( breakdown, tanpa foto wajib ).
// Checklist personal per HP (localStorage per tanggal).

export interface BreakdownGroup {
  title: string;
  items: string[];
}

export const BREAKDOWN: BreakdownGroup[] = [
  {
    title: 'Persiapan Awal Piket',
    items: [
      'Hadir sesuai jadwal piket',
      'Mengisi daftar kehadiran',
      'Membuka ruang/Mako Menwa',
      'Menyalakan lampu dan perangkat yang diperlukan',
      'Memastikan kondisi ruangan aman dan bersih',
      'Mengecek kunci, pintu, jendela, dan fasilitas ruangan',
    ],
  },
  {
    title: 'Menjaga Mako Selama Piket',
    items: [
      'Menjaga keamanan dan ketertiban Mako',
      'Menjaga kebersihan dan kerapian ruangan',
      'Memantau keluar-masuk anggota/tamu',
      'Mengisi buku tamu',
      'Menerima dan mengarahkan tamu yang datang',
      'Tidak meninggalkan Mako tanpa pengganti',
      'Menjaga barang dan inventaris Menwa',
      'Memastikan penggunaan fasilitas sesuai aturan',
    ],
  },
  {
    title: 'Administrasi & Inventaris',
    items: [
      'Memperbarui papan informasi/papan tugas',
      'Mengecek inventaris',
      'Mencatat barang yang dipinjam/dikembalikan',
      'Mengisi logbook piket',
      'Mencatat kejadian penting selama piket',
      'Melaporkan kerusakan atau kehilangan kepada komandan/pengurus',
      'Menerima surat masuk',
      'Mengisi agenda surat masuk',
      'Distribusi surat',
    ],
  },
  {
    title: 'Kegiatan Selama Piket',
    items: [
      'Membantu kebutuhan kegiatan Menwa yang berlangsung',
      'Menjaga kesiapan ruangan untuk rapat/kegiatan',
      'Membantu anggota atau pengurus yang membutuhkan informasi',
      'Menjaga suasana serambi tetap tertib',
    ],
  },
  {
    title: 'Sebelum Meninggalkan Piket',
    items: [
      'Membersihkan dan merapikan Mako',
      'Memastikan barang/inventaris kembali pada tempatnya',
      'Mematikan perangkat yang tidak diperlukan',
      'Mengecek pintu, jendela, listrik, dan fasilitas',
      'Memastikan catatan akhir di logbook, agenda surat masuk & buku tamu',
      'Melakukan serah terima dengan petugas piket berikutnya',
      'Membuat catatan lapsit & menyampaikan kejadian penting kepada piket berikutnya',
    ],
  },
];
