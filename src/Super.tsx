import { useEffect, useState } from 'react';
import {
  isOnline, loadAttendance, loadChecks, loadEvidence, loadFaces, loadLapsit,
  loadState, superGet, verifySuper,
  type AppState, type AttRow, type EvidenceRow, type FaceRow, type FeedItem,
  type LapsitRow, type Overview, type SwapRow, type TaskRow,
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
  const [faces, setFaces] = useState<FaceRow[]>([]);
  const [att, setAtt] = useState<AttRow[]>([]);
  const [ev, setEv] = useState<EvidenceRow[]>([]);
  const [laps, setLaps] = useState<LapsitRow[]>([]);
  const [checks, setChecks] = useState<TaskRow[]>([]);
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  const [preview, setPreview] = useState<string | null>(null);

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
      setFaces(await loadFaces());
    })();
  }, [ok]);

  useEffect(() => {
    if (!ok) return;
    (async () => {
      setAtt((await loadAttendance(date, date)) ?? []);
      setEv((await loadEvidence(date, date)) ?? []);
      setLaps((await loadLapsit(date, date)) ?? []);
      const c = await loadChecks(date);
      if (c) setChecks(c);
    })();
  }, [ok, date]);

  if (!ok) {
    return (
      <div className="super">
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
      </div>
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
    <div className="super">
      <div className="suphead">
        <h1>Superadmin</h1>
        <button onClick={() => { sessionStorage.removeItem('super-pin'); onExit(); }}>Tutup</button>
      </div>
      <div className="supcards">
        {cards.map(([label, v]) => (
          <div key={label} className="supcard"><b>{v ?? '…'}</b><span>{label}</span></div>
        ))}
      </div>

      <h2>Pengguna ({members.length})</h2>
      <table className="suptable">
        <thead><tr><th></th><th>Nama</th><th>Jabatan</th><th>Wajah</th><th>Status</th></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.foto ? <img className="ava" src={m.foto} alt="" /> : <i className="pdot" style={{ background: m.warna }} />}</td>
              <td>{m.nama}{m.angkatan ? ` · ${m.angkatan}` : ''}</td>
              <td>{m.jabatan ?? '—'}</td>
              <td>{(faces.find((f) => f.memberId === m.id)?.descriptors.length ?? 0) || '—'}</td>
              <td>{isOnline(m) ? '🟢 online' : '⚫'}</td>
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
      <h3>Bukti foto ({ev.length}/{checks.length} tugas)</h3>
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

      {preview && (
        <div className="preview" onClick={() => setPreview(null)}>
          <div className="pvcard" onClick={(e) => e.stopPropagation()}>
            <img src={preview} alt="bukti" />
            <button className="primary" onClick={() => setPreview(null)}>Tutup</button>
          </div>
        </div>
      )}
    </div>
  );
}
