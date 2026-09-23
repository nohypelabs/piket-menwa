import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  deleteMember, isOnline, loadAttendance, loadEvidence, loadFaceSummary,
  loadLapsit, loadState, superGet, verifySuper,
  type AppState, type AttRow, type EvidenceRow, type FaceSummary, type FeedItem,
  type LapsitRow, type Overview, type SwapRow,
} from './api';
import { dateStr } from './piket';

const fmtTime = (t: number) =>
  new Date(t).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function SuperView({ onExit }: { onExit: () => void }) {
  const [ok, setOk] = useState(sessionStorage.getItem('super-pin') ? true : false);
  const [pin, setPin] = useState('');
  const [date, setDate] = useState(dateStr(0));
  const [state, setState] = useState<AppState | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [faces, setFaces] = useState<FaceSummary[]>([]);
  const [att, setAtt] = useState<AttRow[]>([]);
  const [ev, setEv] = useState<EvidenceRow[]>([]);
  const [laps, setLaps] = useState<LapsitRow[]>([]);
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [lbFrom, setLbFrom] = useState(() => dateStr(0).slice(0, 8) + '01');
  const [lbTo, setLbTo] = useState(() => dateStr(0));
  const [lb, setLb] = useState<{ memberId: string; nama: string; n: number; rata2: number | null }[]>([]);

  const reloadMembers = async () => {
    const s = await loadState();
    setState(s);
    setFaces(await loadFaceSummary());
  };

  const hapus = async (id: string, nama_: string) => {
    if (!confirm(`Hapus ${nama_} + wajah, foto & jadwalnya?`)) return;
    const ok = await deleteMember(id);
    if (!ok) return alert('Gagal hapus (PIN superadmin / online).');
    void reloadMembers();
  };

  const submitPin = async () => {
    const r = await verifySuper(pin);
    if (r) setOk(true);
    else alert(r === null ? 'Server tidak terjangkau.' : 'PIN salah.');
  };

  useEffect(() => {
    if (!ok) return;
    (async () => {
      const s = await loadState();
      setState(s);
      if (s) setSwaps(s.swaps);
      setOv(await superGet<Overview>('/api/super/overview'));
      setFeed((await superGet<FeedItem[]>('/api/super/feed?limit=50')) ?? []);
      setFaces(await loadFaceSummary());
    })();
  }, [ok]);

  useEffect(() => {
    if (!ok) return;
    (async () => {
      setAtt((await loadAttendance(date, date)) ?? []);
      setEv((await loadEvidence(date, date)) ?? []);
      setLaps((await loadLapsit(date, date)) ?? []);
    })();
  }, [ok, date]);

  useEffect(() => {
    if (!ok) return;
    (async () => {
      const r = await superGet<{ rows: { memberId: string; nama: string; n: number; rata2: number | null }[] }>(
        `/api/nilai/leaderboard?from=${lbFrom}&to=${lbTo}`,
      );
      if (!r) return;
      setLb(r.rows.sort((a, b) => (b.rata2 ?? -1) - (a.rata2 ?? -1)));
    })();
  }, [ok, lbFrom, lbTo]);

  if (!ok) {
    return (
      <motion.div
        className="super"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        <h1>Superadmin</h1>
        <p className="hint">Khusus dev — monitoring seluruh data.</p>
        <input
          type="password" inputMode="numeric" placeholder="PIN superadmin"
          value={pin} onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submitPin(); }}
        />
        <div className="row">
          <button className="primary" onClick={submitPin}>Masuk</button>
          <button onClick={onExit}>Tutup</button>
        </div>
      </motion.div>
    );
  }

  const members = state?.members ?? [];
  const nama = (id: string) => members.find((m) => m.id === id)?.nama ?? id;
  const cards: [string, number | undefined][] = [
    ['Anggota', ov?.members],
    ['Online', ov?.online],
    ['Absen hari ini', ov?.attToday],
    ['Foto hari ini', ov?.evToday],
    ['Lapsit hari ini', ov?.lapsitToday],
    ['Tukar pending', ov?.swapsPending],
  ];

  return (
    <motion.div
      className="super"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
    >
      <div className="suphead">
        <h1>Superadmin</h1>
        <button onClick={() => { sessionStorage.removeItem('super-pin'); onExit(); }}>Tutup</button>
      </div>
      <div className="supcards">
        {cards.map(([label, v], i) => (
          <motion.div
            key={label} className="supcard"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: i * 0.05, ease: 'easeOut' }}
          >
            <b>{v ?? '…'}</b><span>{label}</span>
          </motion.div>
        ))}
      </div>

      <h2>Leaderboard Nilai (rahasia)</h2>
      <div className="row">
        <input type="date" value={lbFrom} onChange={(e) => e.target.value && setLbFrom(e.target.value)} />
        <input type="date" value={lbTo} onChange={(e) => e.target.value && setLbTo(e.target.value)} />
      </div>
      <table className="suptable">
        <thead><tr><th>#</th><th>Nama</th><th>Rata²</th><th>Dinilai</th></tr></thead>
        <tbody>
          {lb.map((r, i) => (
            <tr key={r.memberId}>
              <td>{i + 1}</td>
              <td>{r.nama}</td>
              <td><b>{r.rata2 ?? '—'}</b></td>
              <td>{r.n}x</td>
            </tr>
          ))}
          {lb.length === 0 && <tr><td colSpan={4} className="hint">Belum ada nilai terverifikasi.</td></tr>}
        </tbody>
      </table>

      <h2>Pengguna ({members.length})</h2>
      <table className="suptable">
        <thead><tr><th></th><th>Nama</th><th>Jabatan</th><th>Wajah</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.foto ? <img className="ava" src={m.foto} alt="" /> : <i className="pdot" style={{ background: m.warna }} />}</td>
              <td>{m.nama}{m.angkatan ? ` · ${m.angkatan}` : ''}</td>
              <td>{m.jabatan ?? '—'}</td>
              <td>{(faces.find((f) => f.memberId === m.id)?.count ?? 0) || '—'}</td>
              <td>{isOnline(m) ? '🟢 online' : '⚫'}</td>
              <td><button className="supdel" onClick={() => void hapus(m.id, m.nama)}>hapus</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Rekap harian</h2>
      <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
      <h3>Absensi ({att.length})</h3>
      {att.length === 0 && <p className="hint">Belum ada absen.</p>}
      {att.map((a) => (
        <p key={a.id} className="hist">{nama(a.memberId)} — hadir {a.jam}</p>
      ))}
      <h3>Bukti foto ({ev.length}/{state?.templateLen ?? 0} tugas)</h3>
      <div className="evthumbs">
        {ev.map((e) => (
          <img key={e.id} src={e.file} alt={e.tugas} title={`${e.tugas} — ${nama(e.memberId)}`} onClick={() => setPreview(e.file)} />
        ))}
        {ev.length === 0 && <p className="hint">Belum ada foto.</p>}
      </div>
      <h3>Lapsit ({laps.length})</h3>
      {laps.map((l) => (
        <div key={l.id} className="card sm">
          <b>{nama(l.memberId)}</b><span>{l.catatan}</span>
          <span className="dim">{l.lat && l.lng ? `${Number(l.lat).toFixed(5)}, ${Number(l.lng).toFixed(5)}` : 'GPS off'}</span>
        </div>
      ))}
      {laps.length === 0 && <p className="hint">Belum ada lapsit.</p>}
      <h3>Tukar ({swaps.length})</h3>
      {swaps.map((s) => (
        <p key={s.id} className="hist">{nama(s.requester)} ⇄ {nama(s.target)} • {s.status}</p>
      ))}

      <h2>Log aktivitas</h2>
      {feed.map((f, i) => (
        <p key={i} className="hist">[{f.jenis}] {f.teks} <span className="dim">• {fmtTime(f.t)}</span></p>
      ))}
      {feed.length === 0 && <p className="hint">Kosong.</p>}

      <AnimatePresence>
        {preview && (
          <motion.div
            className="preview" onClick={() => setPreview(null)}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="pvcard" onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.94, y: 14 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
            >
              <div className="wmwrap">
                <img src={preview} alt="bukti" />
                <span className="wm">Admin • {new Date().toLocaleString('id-ID')}</span>
              </div>
              <button className="primary" onClick={() => setPreview(null)}>Tutup</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
