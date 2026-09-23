import { ArrowLeftRight, Check, Clock, Plus, Repeat, X } from 'lucide-react';
import { DAYS, dateStr } from '../piket';
import { isOnline } from '../api';
import type { AppStore } from '../hooks/useAppStore';
import { WeekDragBoard } from '../components/WeekDragBoard';

export function MingguanTab({ store }: { store: AppStore }) {
  const {
    rangeLabel, weekOff, setWeekOff, admin, weekLoading, dragSchedule, dragDirty,
    dragSaving, weekOverridden, weekDates, members, moveWeekMember, saveWeekDrag,
    resetWeekDrag, clearWeekOverride, state, nama, warna, removeFrom, addTo,
    pickDay, setPickDay, jamColon, setJam, weekEv, setPreview, swappedDays,
    weekStat, approvedSwaps, putarRotasi, faces,
  } = store;
  return (
    <>
      <div className="minggufill">
        <div className="weeknav">
          <b>{rangeLabel}</b>
          <span>
            <button onClick={() => setWeekOff((w) => w - 1)}>‹</button>
            <button onClick={() => setWeekOff((w) => w + 1)}>›</button>
          </span>
        </div>
        {admin && weekOff !== 0 ? (
          <WeekDragBoard
            weekLoading={weekLoading}
            dragSchedule={dragSchedule}
            dragDirty={dragDirty}
            dragSaving={dragSaving}
            weekOverridden={weekOverridden}
            weekDates={weekDates}
            members={members}
            onMove={moveWeekMember}
            onSave={saveWeekDrag}
            onReset={resetWeekDrag}
            onClearOverride={clearWeekOverride}
          />
        ) : (
          DAYS.map((d, i) => {
            const ds = weekDates[i];
            const isToday = ds === dateStr(0);
            const crewIds = state?.schedule[d] ?? [];
            return (
              <div key={d} className={`dayrow ${isToday ? 'now' : ''}`}>
                <div className="dleft"><b>{['Sen', 'Sel', 'Rab', 'Kam', 'Jum'][i]}</b><span>{new Date(ds + 'T00:00').getDate()}</span></div>
                <div className="dmain">
                  <span className="crewchips">{crewIds.map((id) => {
                    const m = members.find((x) => x.id === id);
                    return (
                      <span key={id} className="chip sm">
                        {m?.foto
                          ? <img className="ava xs" src={m.foto} alt={nama(id)} />
                          : <i style={{ background: warna(id) }} />}
                        {nama(id)}
                      </span>
                    );
                  })}{crewIds.length === 0 && <span className="hint">—</span>}</span>
                  {admin && (
                    <span className="dedit">
                      {crewIds.map((id) => (
                        <button key={id} className="x" onClick={() => removeFrom(d, id)}>{nama(id)} <X size={11} /></button>
                      ))}
                      <button className="addbtn" onClick={() => setPickDay(pickDay === d ? null : d)}>
                        <Plus size={13} /> Tambah personel
                      </button>
                      <span className="jamrow">
                        <Clock size={13} />
                        <label>mulai
                          <input type="time" value={jamColon(d, 0)} onChange={(e) => void setJam(d, 'mulai', e.target.value)} />
                        </label>
                        <span className="dash">–</span>
                        <label>selesai
                          <input type="time" value={jamColon(d, 1)} onChange={(e) => void setJam(d, 'selesai', e.target.value)} />
                        </label>
                      </span>
                      {pickDay === d && (
                        <span className="picklist">
                          {members.filter((m) => !crewIds.includes(m.id)).map((m) => (
                            <button key={m.id} onClick={() => void addTo(d, m.id)}>
                              {m.foto
                                ? <img className="ava" src={m.foto} alt={m.nama} />
                                : <i className="pdot" style={{ background: m.warna }} />}
                              <span>{m.nama}{m.jabatan ? <small> · {m.jabatan}</small> : ''}</span>
                              <Plus size={14} />
                            </button>
                          ))}
                          {members.filter((m) => !crewIds.includes(m.id)).length === 0 && (
                            <span className="hint">Semua anggota sudah di hari ini.</span>
                          )}
                        </span>
                      )}
                    </span>
                  )}
                  {(weekEv[ds] ?? []).length > 0 && (
                    <span className="dayph">
                      {(weekEv[ds] ?? []).map((e) => (
                        <img
                          key={e.id} src={e.file} alt={e.tugas}
                          onClick={() => setPreview({ file: e.file, judul: e.tugas, by: nama(e.memberId), tanggal: ds })}
                        />
                      ))}
                    </span>
                  )}
                </div>
                {swappedDays.has(d) && <em className="swapmark" title="hari ini hasil tukar jadwal"><ArrowLeftRight size={12} /></em>}
                {isToday
                  ? <em className="pill sm">hari ini</em>
                  : weekStat[ds]
                    ? <em className="badge-ok"><Check size={11} /> selesai</em>
                    : <em className="badge-idle" />}
              </div>
            );
          })
        )}
      </div>
      {approvedSwaps.length > 0 && (
        <div className="swaplog">
          <b>Hasil tukar jadwal</b>
          {approvedSwaps.slice(0, 5).map((s) => (
            <p key={s.id} className="hist">
              {nama(s.requester)} <ArrowLeftRight size={11} /> {nama(s.target)} • {s.fromDay} <ArrowLeftRight size={11} /> {s.toDay}
            </p>
          ))}
        </div>
      )}
      {admin && <button className="rotbtn" onClick={putarRotasi}><Repeat size={14} /> Putar rotasi minggu depan (Admin)</button>}
      {admin && (
        <>
          <h2 className="sec">Anggota terdaftar ({members.length})</h2>
          {!store.state?.fromApi
            ? <p className="hint">Butuh online untuk lihat pendaftar.</p>
            : members.length === 0
              ? <p className="hint">Belum ada yang daftar — suruh buka tab Hari Ini → Daftar.</p>
              : members.map((m) => {
                const n = faces.find((f) => f.memberId === m.id)?.count ?? 0;
                return (
                  <div key={m.id} className="facerow">
                    {m.foto
                      ? <img className="ava" src={m.foto} alt={m.nama} />
                      : <i style={{ background: m.warna }} />}
                    <span>{m.nama}{m.jabatan ? ` · ${m.jabatan}` : ''}{m.angkatan ? ` ${m.angkatan}` : ''}</span>
                    {isOnline(m) && <i className="onlinedot" title="online" />}
                    <em className={n ? 'badge-ok' : 'badge-no'}>{n ? <>wajah <Check size={11} /></> : 'tanpa wajah'}</em>
                  </div>
                );
              })}
        </>
      )}
    </>
  );
}
