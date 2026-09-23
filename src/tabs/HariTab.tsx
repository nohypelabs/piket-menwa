import { AnimatePresence, motion } from 'framer-motion';
import { Camera, Check, ChevronDown, Clock, Lock, LockOpen, PartyPopper } from 'lucide-react';
import { BREAKDOWN } from '../breakdown';
import { dateStr } from '../piket';
import { isOnline } from '../api';
import type { AppStore } from '../hooks/useAppStore';

const fmtTanggal = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
const todayLong = () => {
  const s = fmtTanggal.format(new Date());
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function HariTab({ store }: { store: AppStore }) {
  const {
    today, crew, att, members, nama, warna, jamHari, mySlots, me, unlocked,
    needVerify, checks, ev, uploadingTugas, taskTap, pickPhoto, photoRef,
    pendingTugas, onFile, bdDone, bdOpen, setBdOpen, bdSecOpen, setBdSecOpen,
    nilaiHariIni, lapsit, lapsitText, setLapsitText, kirimLapsit, lapsitOpen,
    lapsitOpenAt, jamSelesaiHariIni, tmr, crewBesok, state, setPreview,
    buktiOpen, setBuktiOpen, toggleBd,
  } = store;
  return (
    <>
      <p className="tgl">{todayLong()}</p>
      {today === 'Libur' ? (
        <div className="hero"><b><PartyPopper size={17} /> Libur</b><span>Sabtu–Minggu tidak ada piket.</span></div>
      ) : (
        <div className="hero">
          <div className="herotop">
            <em className="pill">hari ini</em>
            <span className="hday">{today}</span>
          </div>
          <div className="heroatt">
            {crew.map((id) => {
              const row = att.find((a) => a.memberId === id);
              const m = members.find((x) => x.id === id);
              return (
                <div key={id} className="attrow ghost">
                  {m?.foto
                    ? <img className="ava" src={m.foto} alt={nama(id)} />
                    : <i style={{ background: warna(id) }} />}
                  <span>{nama(id)}</span>
                  {m && isOnline(m) && <i className="onlinedot" title="online" />}
                  <em className={row ? 'badge-ok' : 'badge-no'}>{row ? `hadir ${row.jam}` : 'belum'}</em>
                </div>
              );
            })}
            {crew.length === 0 && <span className="hint">Belum ada jadwal.</span>}
          </div>
          <div className="herojam">
            <Clock size={14} />
            <span className="jlabel">mulai</span><b>{(jamHari.split('–')[0] ?? '').trim()}</b>
            <span className="jarrow">→</span>
            <span className="jlabel">selesai</span><b>{(jamHari.split('–')[1] ?? '').trim()}</b>
          </div>
        </div>
      )}
      {today !== 'Libur' && (
        <>
          {mySlots.length === 0 && (
            <p className="hint">Kamu belum masuk roster minggu ini — minta Admin tambahkan via tab Mingguan (mode Admin).</p>
          )}
          {crew.includes(me) && !unlocked && (
            <button className="bigbtn" onClick={needVerify}>
              {att.some((a) => a.memberId === me) ? <><LockOpen size={15} /> Verifikasi wajah (buka checklist)</> : <><Camera size={15} /> Absen tiba (selfie wajah)</>}
            </button>
          )}
          {unlocked && <p className="hint"><Check size={13} /> Wajah terverifikasi — checklist & bukti terbuka sesi ini.</p>}
          <div className="bdgroup">
            <button className="bdhead" onClick={() => setBuktiOpen((o) => !o)}>
              <span>Bukti Piket (Wajib)</span>
              <em>{ev.length}/{checks.length}</em>
              <ChevronDown size={16} className={buktiOpen ? 'rot' : ''} />
            </button>
            <AnimatePresence initial={false}>
              {buktiOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                  style={{ overflow: 'hidden' }}
                >
                  {!unlocked && <p className="hint"><Lock size={12} /> Verifikasi wajah dulu untuk membuka bukti.</p>}
                  <ul className="tasks">
                    {checks.map((c) => {
                      const ph = ev.find((e) => e.tugas === c.judul);
                      const busy = uploadingTugas === c.judul;
                      return (
                        <li
                          key={c.judul}
                          className={unlocked ? '' : 'locked'}
                          onClick={() => taskTap(c)}
                        >
                          <button
                            className="cam"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!unlocked) return needVerify();
                              if (ph) setPreview({ file: ph.file, judul: c.judul, by: nama(ph.memberId), tanggal: dateStr(0) });
                              else pickPhoto(c.judul);
                            }}
                          >
                            {ph
                              ? <img src={ph.file} alt={c.judul} />
                              : busy ? <span className="spin" /> : <Camera size={17} />}
                          </button>
                          <span className={`ttitle ${c.done ? 'strike' : ''}`}>{c.judul}</span>
                          <span className={`box ${c.done ? 'on' : ''}`}>{c.done ? <Check size={13} /> : ''}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <input
                    ref={photoRef} type="file" accept="image/*" capture="environment" hidden
                    onChange={(e) => { void onFile(pendingTugas ?? '', e.target.files?.[0]); e.target.value = ''; }}
                  />
                  <p className="hint">1 tugas = 1 foto (siapa pun yang piket boleh moto). Tap kamera untuk lihat/ganti, tap judul untuk centang. {ev.length}/{checks.length} berfoto.</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="bdgroup top">
            <button className="bdhead" onClick={() => setBdSecOpen((v) => !v)}>
              <span>Rincian Tugas (Opsional)</span>
              <em>{bdDone.length}/{BREAKDOWN.reduce((s, g) => s + g.items.length, 0)}</em>
              <ChevronDown size={16} className={bdSecOpen ? 'rot' : ''} />
            </button>
          </div>
          <AnimatePresence initial={false}>
            {bdSecOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
                style={{ overflow: 'hidden' }}
              >
                <p className="hint">
                  Tercatat di server, ikut menentukan nilai piketmu.
                  {nilaiHariIni != null && <> Nilai hari ini: <b>{nilaiHariIni}</b>/100.</>}
                </p>
                {BREAKDOWN.map((g, gi) => {
                  const done = g.items.filter((_, ii) => bdDone.includes(`${gi}:${ii}`)).length;
                  const open = !!bdOpen[gi];
                  return (
                    <div key={gi} className="bdgroup">
                      <button className="bdhead" onClick={() => setBdOpen((o) => ({ ...o, [gi]: !o[gi] }))}>
                        <span>{gi + 1}. {g.title}</span>
                        <em>{done}/{g.items.length}</em>
                        <ChevronDown size={16} className={open ? 'rot' : ''} />
                      </button>
                      {open && (
                        <AnimatePresence initial={false}>
                          <motion.ul
                            className="tasks"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.22, ease: 'easeOut' }}
                            style={{ overflow: 'hidden' }}
                          >
                            {g.items.map((it, ii) => {
                              const k = `${gi}:${ii}`;
                              const on = bdDone.includes(k);
                              return (
                                <li key={k} className={unlocked ? '' : 'locked'} onClick={() => toggleBd(k)}>
                                  <span className={`box ${on ? 'on' : ''}`}>{on ? <Check size={13} /> : ''}</span>
                                  <span className={on ? 'strike' : ''}>{it}</span>
                                </li>
                              );
                            })}
                          </motion.ul>
                        </AnimatePresence>
                      )}
                    </div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
          <h2>Catatan Lapsit — Akhir Piket</h2>
          {lapsit.length > 0 ? (
            lapsit.map((l) => (
              <div key={l.id} className="card sm">
                <b>{nama(l.memberId)}</b>
                <span>{l.catatan}</span>
                <span className="dim">
                  {new Date(l.createdAt).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {l.lat && l.lng ? ` • ${Number(l.lat).toFixed(5)}, ${Number(l.lng).toFixed(5)}` : ' • GPS off'}
                </span>
              </div>
            ))
          ) : (
            <>
              <textarea
                className="reason" rows={3}
                placeholder="Tulis laporan situasi akhir piket…"
                value={lapsitText} onChange={(e) => setLapsitText(e.target.value)}
              />
              <button
                className="bigbtn"
                disabled={!unlocked || ev.length < checks.length || checks.length === 0 || !lapsitOpen}
                onClick={kirimLapsit}
              >
                Kirim lapsit akhir piket
              </button>
              {unlocked && (ev.length < checks.length) && (
                <p className="hint">Lengkapi {checks.length} foto bukti dulu.</p>
              )}
              {unlocked && ev.length >= checks.length && checks.length > 0 && !lapsitOpen && (
                <p className="hint">Lapsit bisa dikirim mulai {lapsitOpenAt} (30 menit sebelum piket selesai jam {jamSelesaiHariIni}).</p>
              )}
            </>
          )}
          {tmr !== 'Libur' && crewBesok.length > 0 && (
            <p className="besok">● Besok: {crewBesok.map(nama).join(' & ')} • mulai {(state?.jam[tmr] ?? '09.00–15.00').split('–')[0]}</p>
          )}
        </>
      )}
    </>
  );
}
