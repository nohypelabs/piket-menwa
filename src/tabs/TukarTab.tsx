import { ArrowLeftRight } from 'lucide-react';
import { DAYS } from '../piket';
import type { AppStore } from '../hooks/useAppStore';

export function TukarTab({ store }: { store: AppStore }) {
  const {
    meMember, mySlots, me, nama, warna, fromDay, setFromDay, dayDate,
    toDay, target, setToDay, setTarget, state, alasan, setAlasan, submitSwap,
    incoming, decide, outgoing, cancelSwap, admin, othersPending, expanded, setExpanded,
  } = store;
  return (
    <>
      <h2 className="sec">Giliran kamu</h2>
      {!meMember ? (
        <p className="hint">Masuk dengan wajah dulu (tab Hari Ini).</p>
      ) : (
        <div className="opts2">
          {mySlots.map((d) => (
            <button key={d} className={`opt ${fromDay === d ? 'sel' : ''}`} onClick={() => setFromDay(d)}>
              <i style={{ background: warna(me) }} />{nama(me)} • {dayDate(d)}
            </button>
          ))}
          {mySlots.length === 0 && <p className="hint">Kamu tidak ada jadwal minggu ini.</p>}
        </div>
      )}
      <h2 className="sec">Tukar dengan</h2>
      <div className="opts1">
        {DAYS.flatMap((d) =>
          (state?.schedule[d] ?? []).filter((m) => m !== me).map((m) => ({ d, m })),
        ).map(({ d, m }) => (
          <button
            key={`${d}-${m}`}
            className={`opt ${toDay === d && target === m ? 'sel' : ''}`}
            onClick={() => { setToDay(d); setTarget(m); }}
          >
            <i style={{ background: warna(m) }} />{nama(m)} • {dayDate(d)}
          </button>
        ))}
      </div>
      <textarea
        className="reason" rows={3}
        placeholder="Alasan (opsional), misal: ada ujian pagi"
        value={alasan} onChange={(e) => setAlasan(e.target.value)}
      />
      <button className="bigbtn" onClick={submitSwap}>Kirim permintaan tukar</button>
      {incoming.map((w) => (
        <div key={w.id} className="waitcard">
          <i className="pdot" style={{ background: warna(w.requester) }} />
          <span>{nama(w.requester)} meminta tukar<br />{dayDate(w.fromDay)} <ArrowLeftRight size={12} /> {dayDate(w.toDay)}</span>
        </div>
      ))}
      {incoming.length > 0 && (
        <div className="row waitrow">
          <button className="primary" onClick={() => decide(incoming[0], true)}>Terima</button>
          <button onClick={() => decide(incoming[0], false)}>Tolak</button>
        </div>
      )}
      {outgoing.map((w) => (
        <div key={w.id} className="waitcard">
          <i className="pdot" style={{ background: warna(w.target) }} />
          <span>Ke {nama(w.target)}<br />{dayDate(w.fromDay)} <ArrowLeftRight size={12} /> {dayDate(w.toDay)} • menunggu</span>
          <button className="ketua" onClick={() => cancelSwap(w)}>batalkan</button>
        </div>
      ))}
      {admin && othersPending.length > 0 && (
        <>
          <h2 className="sec">Antrean lain (Admin override)</h2>
          {othersPending.map((w) => (
            <div key={w.id}>
              <div className="waitcard">
                <i className="pdot" style={{ background: warna(w.requester) }} />
                <span>{nama(w.requester)} → {nama(w.target)}<br />{dayDate(w.fromDay)} <ArrowLeftRight size={12} /> {dayDate(w.toDay)}</span>
                <button className="ketua" onClick={() => setExpanded(expanded === w.id ? null : w.id)}>aksi Admin</button>
              </div>
              {expanded === w.id && (
                <div className="row waitrow">
                  <button className="primary" onClick={() => { setExpanded(null); decide(w, true); }}>Approve</button>
                  <button onClick={() => { setExpanded(null); decide(w, false); }}>Tolak</button>
                </div>
              )}
            </div>
          ))}
        </>
      )}
      {(state?.swaps ?? []).some((s) => s.status !== 'pending') && (
        <>
          <h2 className="sec">Riwayat</h2>
          {(state?.swaps ?? []).filter((s) => s.status !== 'pending').map((s) => (
            <p key={s.id} className="hist">{nama(s.requester)} <ArrowLeftRight size={11} /> {nama(s.target)} • {s.fromDay} <ArrowLeftRight size={11} /> {s.toDay} • {s.status}</p>
          ))}
        </>
      )}
    </>
  );
}
