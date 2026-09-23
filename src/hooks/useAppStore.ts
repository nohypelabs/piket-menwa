import { useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelSwapRemote, clearPin, clearAttest, clearWeekRosterRemote, createSwapRemote, decideSwapRemote,
  dropPush, ensurePush, loadAttendance, loadBreakdown, loadChecks, loadEvidence, loadFaceSummary,
  loadNilaiToday, matchFace,
  loadLapsit, loadState, loadWeekRoster, localChecks, loginPin, markAttendance, ping,
  registerMember, saveRosterRemote, saveWeekRosterRemote, setLoginPin, setProfilePhoto, submitLapsit,
  toggleBreakdown, uploadEvidence, verifyPin,
  type AppState, type AttRow, type EvidenceRow, type FaceSummary, type LapsitRow,
  type Member, type SwapRow, type TaskRow,
} from '../api';
import { getGeo, compressPhoto, stampPhoto, type Geo } from '../bukti';
import { ensureModels, ting, warmAudio } from '../face';
import { profileSchema, type Profile } from '../Welcome';
import { DAYS, dateStr, load, save, memberById, todayKeyID, tomorrowKeyID, type DayKey } from '../piket';

export type Tab = 'hari' | 'minggu' | 'tukar';

export interface PreviewState { file: string; judul: string; by: string; tanggal: string }

// Flag "sudah verifikasi wajah hari ini" harus terikat PER-ANGGOTA, bukan
// cuma per-tanggal — device sering gantian dipakai beberapa anggota piket
// (satu HP/tablet bersama). Kalau cuma per-tanggal, anggota kedua yang
// login di device yang sama otomatis kebaca "unlocked" dari sesi anggota
// pertama walau dia sendiri belum verifikasi (bug tombol absen kedip lalu
// hilang: sempat unlocked=false sesaat, lalu ke-overwrite true oleh flag
// stale milik orang lain begitu `me` di-set).
const unlockKey = (memberId: string) => `piket-unlock-date:${memberId}`;

export function useAppStore() {
  const [tab, setTab] = useState<Tab>('hari');
  const [state, setState] = useState<AppState | null>(null);
  const [checks, setChecks] = useState<TaskRow[]>([]);
  const [ev, setEv] = useState<EvidenceRow[]>([]);
  const [uploadingTugas, setUploadingTugas] = useState<string | null>(null);
  const [pendingTugas, setPendingTugas] = useState<string | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [weekEv, setWeekEv] = useState<Record<string, EvidenceRow[]>>({});
  const knownSwaps = useRef<Set<string> | null>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [lapsit, setLapsit] = useState<LapsitRow[]>([]);
  const [lapsitText, setLapsitText] = useState('');
  const [bdOpen, setBdOpen] = useState<Record<number, boolean>>({});
  const [buktiOpen, setBuktiOpen] = useState(true);
  const [bdDone, setBdDone] = useState<string[]>([]);
  const [bdSecOpen, setBdSecOpen] = useState(false);
  const [nilaiHariIni, setNilaiHariIni] = useState<number | null>(null);
  const [faces, setFaces] = useState<FaceSummary[]>([]);
  const [att, setAtt] = useState<AttRow[]>([]);
  const [unlocked, setUnlocked] = useState(false); // wajah terverifikasi sesi ini
  const [cam, setCam] = useState<null | { mode: 'absen' | 'login' | 'register' }>(null);
  const [camMsg, setCamMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: 'error' | 'ok' | 'info' } | null>(null);
  const [me, setMe] = useState(() => {
    // Sesi hanya berlaku 1 hari → tiap hari wajib verifikasi wajah ulang.
    try {
      if (localStorage.getItem('piket-me-date') !== dateStr(0)) return '';
      return load('piket-me', '');
    } catch {
      return '';
    }
  });
  const [regName, setRegName] = useState('');
  const [regAngkatan, setRegAngkatan] = useState('');
  const [regJabatan, setRegJabatan] = useState('');
  const [regPin, setRegPin] = useState('');
  const [profiling, setProfiling] = useState(false);
  const [showUnknown, setShowUnknown] = useState(false);
  // Hasil identifikasi wajah yang MENUNGGU KONFIRMASI USER sebelum benar-benar
  // login — mencegah kasus salah-kenali (2 wajah mirip di kamera murah) yang
  // langsung login-kan orang ke akun orang lain tanpa sempat dicek.
  const [confirmHit, setConfirmHit] = useState<{ memberId: string; ambiguous: boolean } | null>(null);
  const [navHidden, setNavHidden] = useState(false);
  const [showLogout, setShowLogout] = useState(false);
  const [pinNew, setPinNew] = useState('');
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const selfieInputRef = useRef<HTMLInputElement>(null);

  // Foto profil OPSIONAL (avatar) — file dipilih manual dari galeri/kamera,
  // BUKAN dari proses scan wajah biometrik. Dikompres dulu spy hemat data.
  const onAvatarFile = async (f: File | undefined) => {
    if (!f || !me) return;
    setAvatarBusy(true);
    try {
      const dataUrl = await compressPhoto(f);
      const res = await setProfilePhoto(me, dataUrl);
      if (res.ok) {
        await refresh();
        setToast({ msg: 'Foto profil diperbarui', kind: 'ok' });
      } else {
        setToast({ msg: res.error ?? 'Gagal ganti foto', kind: 'error' });
      }
    } catch {
      setToast({ msg: 'Gagal baca foto', kind: 'error' });
    } finally {
      setAvatarBusy(false);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  };
  const removeAvatar = async () => {
    if (!me) return;
    setAvatarBusy(true);
    const res = await setProfilePhoto(me, '');
    setAvatarBusy(false);
    if (res.ok) { await refresh(); setToast({ msg: 'Foto profil dihapus', kind: 'ok' }); }
  };

  const pinLogin = async (pin: string) => {
    const r = await loginPin(pin);
    if (r.ok && r.memberId) {
      setMe(r.memberId);
      setToast({ msg: `Login berhasil — selamat datang, ${r.nama}`, kind: 'ok' });
      void ensurePush(r.memberId);
      try { sessionStorage.setItem(unlockKey(r.memberId), dateStr(0)); } catch { /* abaikan */ }
      setUnlocked(true);
    }
    return r;
  };

  const savePin = async () => {
    if (!me) return;
    const r = await setLoginPin(me, pinNew);
    setPinMsg(r.ok ? 'PIN tersimpan ✓' : (r.error ?? 'Gagal simpan.'));
    if (r.ok) setPinNew('');
  };
  const [hash, setHash] = useState(() => location.hash);
  const [, setTitleTaps] = useState(0);
  const [admin, setAdmin] = useState(() => sessionStorage.getItem('piket-admin') === '1');
  const [showPin, setShowPin] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [online, setOnline] = useState(navigator.onLine);

  const [target, setTarget] = useState('maxwell');
  const [fromDay, setFromDay] = useState<DayKey>('Senin');
  const [toDay, setToDay] = useState<DayKey>('Selasa');
  const [alasan, setAlasan] = useState('');
  const [weekOff, setWeekOff] = useState(0);
  const [weekStat, setWeekStat] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pickDay, setPickDay] = useState<DayKey | null>(null);
  // ---- Mingguan minggu depan/seterusnya: override per-minggu (drag-drop) ----
  const [weekSchedule, setWeekSchedule] = useState<Record<DayKey, string[]> | null>(null);
  const [weekJamRow, setWeekJamRow] = useState<Record<DayKey, string>>({} as Record<DayKey, string>);
  const [weekOverridden, setWeekOverridden] = useState(false);
  const [weekLoading, setWeekLoading] = useState(false);
  const [dragSchedule, setDragSchedule] = useState<Record<DayKey, string[]> | null>(null);
  const [dragDirty, setDragDirty] = useState(false);
  const [dragSaving, setDragSaving] = useState(false);

  useEffect(() => { save('piket-me', me); }, [me]);
  useEffect(() => {
    try {
      if (me) localStorage.setItem('piket-me-date', dateStr(0));
      else localStorage.removeItem('piket-me-date');
    } catch { /* abaikan */ }
  }, [me]);
  useEffect(() => {
    sessionStorage.setItem('piket-admin', admin ? '1' : '0');
    if (!admin) clearPin();
  }, [admin]);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => {
    // Panaskan model wajah sejak app dibuka → pas tap login sudah siap.
    ensureModels().catch(() => {});
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const refresh = async () => {
    const s = await loadState();
    setState(s);
    if (!s.fromApi) save('piket-schedule', s.schedule);
    const c = s.fromApi && me ? await loadChecks(dateStr(0), me) : null;
    setChecks(c ?? localChecks());
    const e = s.fromApi ? await loadEvidence(dateStr(0), dateStr(0), admin ? undefined : me || undefined) : null;
    setEv(e ?? []);
    setBdDone(
      s.fromApi && me ? await loadBreakdown(dateStr(0), me) : load<string[]>(`piket-bd-${dateStr(0)}-${me}`, []),
    );
    setNilaiHariIni(s.fromApi && me ? await loadNilaiToday(dateStr(0), me) : null);
    if (s.fromApi) {
      setFaces(admin ? await loadFaceSummary() : []);
      const a = await loadAttendance(dateStr(0), dateStr(0));
      setAtt(a ?? []);
      setLapsit((await loadLapsit(dateStr(0), dateStr(0), admin ? undefined : me || undefined)) ?? []);
      // Notifikasi pengajuan tukar baru (untuk yang diminta / Admin).
      const pend = s.swaps.filter((x) => x.status === 'pending');
      if (knownSwaps.current) {
        const fresh = pend.filter((x) => !knownSwaps.current!.has(x.id));
        const nm = (id: string) => s.members.find((m) => m.id === id)?.nama ?? id;
        const mine = fresh.filter((x) => x.target === me);
        const forAdmin = admin ? fresh.filter((x) => x.target !== me) : [];
        const show = [...mine, ...forAdmin];
        if (show.length > 0) {
          const w = show[0];
          const msg = `Tukar baru: ${nm(w.requester)} → ${nm(w.target)} (${w.fromDay} ⇄ ${w.toDay})`;
          setToast({ msg, kind: 'info' });
          if ('Notification' in window && Notification.permission === 'granted') {
            try { new Notification('Piket — tukar jadwal', { body: msg }); } catch { /* abaikan */ }
          }
        }
      }
      knownSwaps.current = new Set(s.swaps.map((x) => x.id));
    } else {
      setFaces([]);
      setAtt([]);
      setLapsit([]);
    }
    setUnlocked(me !== '' && sessionStorage.getItem(unlockKey(me)) === dateStr(0));
  };
  useEffect(() => { void refresh(); }, []);

  const members: Member[] = useMemo(
    () => state?.members ?? [], [state],
  );
  const meMember = members.find((m) => m.id === me) ?? null;
  useEffect(() => {
    // Heartbeat presence tiap 30 dtk selama login.
    if (!meMember || !state?.fromApi) return;
    ping(me);
    const t = setInterval(() => ping(me), 30000);
    const onVis = () => { if (document.visibilityState === 'visible') ping(me); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, state?.fromApi]);
  const nama = (id: string) =>
    members.find((m) => m.id === id)?.nama ?? memberById(id).nama;
  const warna = (id: string) =>
    members.find((m) => m.id === id)?.warna ?? memberById(id).warna;

  const today = todayKeyID();
  const tmr = tomorrowKeyID();
  const crew: string[] = today === 'Libur' ? [] : (state?.schedule[today] ?? []);
  const crewBesok: string[] = tmr === 'Libur' ? [] : (state?.schedule[tmr] ?? []);
  const jamHari = today === 'Libur' ? '' : (state?.jam[today] ?? '09.00–15.00');
  // Lapsit cuma boleh dikirim 30 menit sebelum jam selesai piket HARI INI.
  // Estimasi tampilan pakai jadwal template (state.jam) — kalau admin
  // override jam khusus minggu ini via drag-drop, validasi FINAL tetap di
  // server (endpoint akan tolak dgn pesan jelas kalau estimasi ini meleset).
  const jamSelesaiHariIni = jamHari ? jamHari.split('–')[1] ?? '' : '';
  const lapsitOpenAt = (() => {
    if (!jamSelesaiHariIni) return '';
    const [hh, mm] = jamSelesaiHariIni.split('.').map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return '';
    const t = new Date(); t.setHours(hh, mm - 30, 0, 0);
    return `${String(t.getHours()).padStart(2, '0')}.${String(t.getMinutes()).padStart(2, '0')}`;
  })();
  const lapsitOpen = (() => {
    if (!jamSelesaiHariIni) return true; // gak ada jadwal jam → jangan block
    const [hh, mm] = jamSelesaiHariIni.split('.').map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return true;
    const batas = new Date(); batas.setHours(hh, mm - 30, 0, 0);
    return new Date() >= batas;
  })();
  const doneCount = checks.filter((c) => c.done).length;
  const pending = (state?.swaps ?? []).filter((s) => s.status === 'pending');
  const incoming = pending.filter((s) => s.target === me);
  const outgoing = pending.filter((s) => s.requester === me);
  const othersPending = pending.filter((s) => s.target !== me && s.requester !== me);
  const approvedSwaps = useMemo(() => (state?.swaps ?? [])
    .filter((s) => s.status === 'approved')
    .sort((a, b) => b.createdAt - a.createdAt), [state]);
  const swappedDays = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86400000;
    const set = new Set<DayKey>();
    for (const s of approvedSwaps) {
      if (s.createdAt >= weekAgo) {
        set.add(s.fromDay);
        set.add(s.toDay);
      }
    }
    return set;
  }, [approvedSwaps]);
  const bellDot = tmr !== 'Libur' && (state?.schedule[tmr] ?? []).includes(me);

  // ---- Mingguan: tanggal Senin–Jumat minggu tampil + status selesai per tanggal ----
  const ABBR = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum'];
  const weekDates = useMemo(() => {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7; // Senin=0
    const mon = new Date(now);
    mon.setDate(now.getDate() - dow + weekOff * 7);
    return DAYS.map((_, i) => {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
  }, [weekOff]);

  useEffect(() => {
    if (tab !== 'minggu') return;
    let live = true;
    (async () => {
      const out: Record<string, boolean> = {};
      const evRows = state?.fromApi && admin ? await loadEvidence(weekDates[0], weekDates[4]) : null;
      const lapRows = state?.fromApi && admin ? await loadLapsit(weekDates[0], weekDates[4]) : null;
      if (live) {
        const grouped: Record<string, EvidenceRow[]> = {};
        for (const e of evRows ?? []) {
          (grouped[e.tanggal] ??= []).push(e);
        }
        setWeekEv(grouped);
      }
      if (!admin) { if (live) setWeekStat({}); return; } // non-admin: rekap tim tidak dibuka (privasi per-orang)
      await Promise.all(weekDates.map(async (ds, i) => {
        const dayKey = DAYS[i]; // weekDates disusun Senin..Jumat, selaras index DAYS
        const dayCrew = state?.schedule[dayKey] ?? [];
        if (dayCrew.length === 0) return;
        // SEMUA anggota yang piket hari itu wajib lengkap sendiri-sendiri
        // (checklist + foto miliknya) — bukan cukup salah satu orang saja.
        const memberDone = await Promise.all(dayCrew.map(async (mid) => {
          const rows = state?.fromApi ? await loadChecks(ds, mid) : localChecks(ds);
          const tasksDone = !!rows?.length && rows.every((r) => r.done);
          if (!tasksDone) return false;
          if (!state?.fromApi || !evRows) return tasksDone;
          const titles = (rows ?? []).map((r) => r.judul);
          const evOk = titles.length > 0 && titles.every((t) =>
            evRows.some((e) => e.tanggal === ds && e.tugas === t && e.memberId === mid));
          const lapOk = !lapRows || lapRows.some((l) => l.tanggal === ds && l.memberId === mid);
          return evOk && lapOk;
        }));
        if (memberDone.every(Boolean)) out[ds] = true;
      }));
      if (live) setWeekStat(out);
    })();
    return () => { live = false; };
  }, [tab, weekOff, state?.fromApi]);

  // Minggu depan & seterusnya (weekOff !== 0): jadwal bisa beda dari template,
  // di-drag-drop terpisah per minggu (lihat db/roster.weekStart + /api/roster/week).
  // Minggu berjalan (weekOff === 0) tetap ikut template dasar seperti sebelumnya.
  useEffect(() => {
    if (tab !== 'minggu' || weekOff === 0 || !state?.fromApi) {
      setWeekSchedule(null);
      setDragSchedule(null);
      setDragDirty(false);
      return;
    }
    let live = true;
    setWeekLoading(true);
    (async () => {
      const w = await loadWeekRoster(weekDates[0]);
      if (!live) return;
      setWeekLoading(false);
      if (!w) return;
      setWeekSchedule(w.schedule);
      setWeekJamRow(w.jam);
      setWeekOverridden(w.overridden);
      setDragSchedule(w.schedule);
      setDragDirty(false);
    })();
    return () => { live = false; };
  }, [tab, weekOff, weekDates, state?.fromApi]);


  const rangeLabel = (() => {
    const a = new Date(weekDates[0] + 'T00:00');
    const b = new Date(weekDates[4] + 'T00:00');
    const m = new Intl.DateTimeFormat('id-ID', { month: 'long' });
    return a.getMonth() === b.getMonth()
      ? `${a.getDate()}–${b.getDate()} ${m.format(b)}`
      : `${a.getDate()} ${m.format(a)} – ${b.getDate()} ${m.format(b)}`;
  })();

  const putarRotasi = async () => {    if (!state || !admin) return;
    if (!confirm('Putar rotasi? Crew tiap hari geser maju 1 hari (Jumat → Senin).')) return;
    const sch = state.schedule;
    const next = { Senin: sch.Jumat, Selasa: sch.Senin, Rabu: sch.Selasa, Kamis: sch.Rabu, Jumat: sch.Kamis };
    setState({ ...state, schedule: next });
    if (state.fromApi) await saveRosterRemote(next, state.jam);
    else save('piket-schedule', next);
    setWeekOff(0);
  };

  // ---- Tukar: tanggal minggu berjalan + slot giliran ----
  const tukarDates = useMemo(() => {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7; // Senin=0
    const mon = new Date(now);
    mon.setDate(now.getDate() - dow);
    return DAYS.map((_, i) => {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
  }, []);
  const dayDate = (d: DayKey) => {
    const i = DAYS.indexOf(d);
    return `${ABBR[i]} ${new Date(tukarDates[i] + 'T00:00').getDate()}`;
  };
  const mySlots = useMemo(
    () => DAYS.filter((d) => state?.schedule[d]?.includes(me)), [state, me],
  );

  // jaga default pilihan tetap valid saat ganti user / data reload
  useEffect(() => {
    if (!state) return;
    if (!state.schedule[fromDay]?.includes(me)) {
      const first = DAYS.find((d) => state.schedule[d]?.includes(me));
      if (first) setFromDay(first);
    }
    if (target === me || !state.schedule[toDay]?.includes(target) || toDay === fromDay) {
      const cand = DAYS.flatMap((d) =>
        (state.schedule[d] ?? []).filter((m) => m !== me).map((m) => ({ d, m })),
      ).find((c) => c.d !== (state.schedule[fromDay]?.includes(me) ? fromDay : DAYS.find((d) => state.schedule[d]?.includes(me))));
      if (cand) { setToDay(cand.d); setTarget(cand.m); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, me, fromDay]);

  const taskTap = (c: TaskRow) => {
    if (!unlocked) return needVerify();
    const hasPhoto = ev.some((e) => e.tugas === c.judul);
    if (!hasPhoto) return pickPhoto(c.judul); // ceklis wajib foto dulu
    // Immutable: sudah ada foto = final, tidak bisa uncheck/ganti.
    setToast({ msg: 'Laporan foto wajib sudah diterima, tidak perlu melakukannya 2x.', kind: 'info' });
  };

  const onFile = async (judul: string, f: File | undefined) => {
    if (!f || !judul) return;
    setUploadingTugas(judul);
    try {
      const dataUrl = await stampPhoto(f, geo); // kompres + stempel tgl/jam (+koordinat)
      const res = await uploadEvidence(dateStr(0), me, judul, dataUrl);
      if (!res.ok) {
        alert(res.error ?? 'Gagal upload');
      } else {
        // server otomatis menandai tugas selesai → refresh keduanya
        const [c, e] = await Promise.all([loadChecks(dateStr(0), me), loadEvidence(dateStr(0), dateStr(0), admin ? undefined : me || undefined)]);
        if (c) setChecks(c);
        if (e) setEv(e);
        if (me) setNilaiHariIni(await loadNilaiToday(dateStr(0), me));
      }
    } catch {
      alert('Baca/kompres foto gagal');
    } finally {
      setUploadingTugas(null);
      setPendingTugas(null);
    }
  };

  const pickPhoto = (judul: string) => {
    setPendingTugas(judul);
    photoRef.current?.click();
  };

  const toggleBd = (key: string) => {
    if (!unlocked) return needVerify();
    setBdDone((prev) => {
      const willDo = !prev.includes(key);
      const next = willDo ? [...prev, key] : prev.filter((k) => k !== key);
      if (state?.fromApi && me) {
        void toggleBreakdown(dateStr(0), me, key, willDo).then(() => {
          void loadNilaiToday(dateStr(0), me).then(setNilaiHariIni);
        });
      } else {
        save(`piket-bd-${dateStr(0)}-${me}`, next);
      }
      return next;
    });
  };

  const kirimLapsit = async () => {
    if (!unlocked) return needVerify();
    if (!state?.fromApi) return alert('Butuh online untuk kirim lapsit.');
    const g = (await getGeo()) ?? geo;
    if (g) setGeo(g);
    const res = await submitLapsit(dateStr(0), me, lapsitText, g);
    if (!res.ok) return alert(res.error ?? 'Gagal kirim lapsit');
    setLapsitText('');
    const rows = await loadLapsit(dateStr(0), dateStr(0), admin ? undefined : me || undefined);
    if (rows) setLapsit(rows);
    if (me) setNilaiHariIni(await loadNilaiToday(dateStr(0), me));
  };

  const needVerify = () => {
    if (!state?.fromApi) return alert('Butuh online untuk verifikasi wajah.');
    if (!meMember) return;
    if (!crew.includes(me)) {
      return alert('Kamu tidak ada jadwal hari ini — minta Admin susun roster dulu (tab Mingguan, mode Admin).');
    }
    if (meMember.noFaceConsent) {
      // Akun PIN-only: absen via selfie+watermark (bukan face-match).
      selfieInputRef.current?.click();
      return;
    }
    warmAudio();
    setCamMsg(null);
    setCam({ mode: 'absen' });
  };

  const onSelfieAbsen = async (f: File | undefined) => {
    if (!f || !meMember) return;
    setAvatarBusy(true);
    try {
      const g = (await getGeo()) ?? geo;
      if (g) setGeo(g);
      const dataUrl = await stampPhoto(f, g, 1280, meMember.nama);
      const res = await markAttendance(dateStr(0), me, dataUrl);
      if (!res.ok) {
        setToast({ msg: res.error ?? 'Gagal absen.', kind: 'error' });
        return;
      }
      const a = await loadAttendance(dateStr(0), dateStr(0));
      if (a) setAtt(a);
      setUnlocked(true);
      try { sessionStorage.setItem(unlockKey(me), dateStr(0)); } catch { /* abaikan */ }
      ting(990, 0.18);
      setToast({ msg: 'Absen berhasil — checklist & bukti terbuka', kind: 'ok' });
      void ensurePush(me);
    } catch {
      setToast({ msg: 'Baca/kompres foto gagal.', kind: 'error' });
    } finally {
      setAvatarBusy(false);
    }
  };

  const loginCam = () => {
    if (!state?.fromApi) return alert('Butuh online untuk masuk.');
    warmAudio();
    setCamMsg(null);
    setCam({ mode: 'login' }); // selalu kamera dulu; wajah baru → form nama+angkatan
  };

  const logout = () => {
    void dropPush();
    clearAttest();
    try { if (me) sessionStorage.removeItem(unlockKey(me)); } catch { /* abaikan */ }
    setMe('');
    setUnlocked(false);
    setShowLogout(false);
  };

  const onProfileDone = (p: Profile) => {
    setRegName(p.nama);
    setRegAngkatan(p.angkatan);
    setRegJabatan(p.jabatan);
    setRegPin(p.pin);
    setProfiling(false);
    if (!p.consentWajah) {
      // Menolak scan wajah → daftar langsung tanpa kamera, PIN jadi satu-satunya kunci.
      void finishRegister(p.nama, p.angkatan, p.jabatan, p.pin, [], true);
      return;
    }
    warmAudio();
    setCamMsg('Tap Mulai, ikuti tahap: tahan – kanan – kiri');
    setCam({ mode: 'register' });
  };

  const finishRegister = async (
    namaV: string, angkatanV: string, jabatanV: string, pinV: string, ds: number[][], noFaceConsent: boolean,
  ) => {
    const res = await registerMember(namaV, angkatanV, jabatanV, pinV, ds, noFaceConsent);
    if (res.ok && res.memberId) {
      const hello = `${namaV} (${jabatanV}, angkatan ${angkatanV})`;
      await refresh();
      setMe(res.memberId);
      setUnlocked(!noFaceConsent); // PIN-only: tidak ada verifikasi wajah, tetap terkunci sampai login PIN eksplisit
      if (!noFaceConsent) {
        try { sessionStorage.setItem(unlockKey(res.memberId), dateStr(0)); } catch { /* abaikan */ }
      }
      if (res.memberId) void ensurePush(res.memberId);
      void getGeo().then(setGeo);
      setRegName('');
      setRegAngkatan('');
      setRegJabatan('');
      setRegPin('');
      setProfiling(false);
      setCam(null);
      setCamMsg(null);
      alert('Pendaftaran berhasil — kamu masuk sebagai ' + hello);
    } else {
      setCamMsg(res.error ?? 'Gagal daftar.');
      setToast({ msg: res.error ?? 'Gagal daftar.', kind: 'error' });
    }
  };

  // Duplikat ketahuan di tahap 1 → tolak cepat tanpa menunggu 3 tahap.
  const handleDuplicate = (memberId: string) => {
    const msg = `Wajah ini sudah terdaftar sebagai ${nama(memberId)} — pakai Masuk, jangan daftar lagi.`;
    setCamMsg(msg);
    setToast({ msg, kind: 'error' });
  };

  const handleEnroll = async (ds: number[][]) => {
    const parsed = profileSchema.safeParse({ nama: regName, angkatan: regAngkatan, jabatan: regJabatan, pin: regPin });
    if (!parsed.success) {
      setCamMsg(parsed.error.issues[0]?.message ?? 'Profil invalid.');
      return;
    }
    // Tolak wajah yang sudah terdaftar (nama beda pun tetap ketahuan) — cek
    // di SERVER, bukan bandingkan array embedding di browser.
    for (const d of ds) {
      const dupe = await matchFace(d);
      if (dupe) {
        const msg = `Wajah ini sudah terdaftar sebagai ${nama(dupe.memberId)} — pakai Masuk, jangan daftar lagi.`;
        setCamMsg(msg);
        setToast({ msg, kind: 'error' });
        return;
      }
    }
    const res = await registerMember(parsed.data.nama, parsed.data.angkatan, parsed.data.jabatan, parsed.data.pin, ds);
    if (res.ok && res.memberId) {
      const hello = `${parsed.data.nama} (${parsed.data.jabatan}, angkatan ${parsed.data.angkatan})`;
      await refresh();
      setMe(res.memberId);
      setUnlocked(true); // wajah baru saja diverifikasi → langsung terbuka
      try { sessionStorage.setItem(unlockKey(res.memberId), dateStr(0)); } catch { /* abaikan */ }
      if (res.memberId) void ensurePush(res.memberId);
      void getGeo().then(setGeo);
      setRegName('');
      setRegAngkatan('');
      setRegJabatan('');
      setRegPin('');
      setProfiling(false);
      setCam(null);
      setCamMsg(null);
      alert('Pendaftaran berhasil — kamu masuk sebagai ' + hello);
    } else {
      setCamMsg(res.error ?? 'Gagal daftar.');
    }
  };

  const handleDescriptor = async (d: number[]) => {
    if (!cam) return;
    if (cam.mode === 'login') {
      const hit = await matchFace(d);
      if (!hit) {
        setCam(null);
        setCamMsg(null);
        setShowUnknown(true); // wajah baru → suruh daftar dulu
        return;
      }
      // Selalu minta konfirmasi visual eksplisit sebelum benar-benar login —
      // wajah dari kamera murah/cahaya kurang bisa mirip antar 2 orang beda,
      // jadi jangan langsung percaya hasil algoritma tanpa user cek foto.
      setCam(null);
      setCamMsg(null);
      setConfirmHit({ memberId: hit.memberId, ambiguous: !!hit.ambiguous });
      return;
    }
    if (cam.mode !== 'absen') return;
    const hit = await matchFace(d);
    if (!hit) {
      setCamMsg('Wajah tidak dikenal — Daftar dulu ya.');
      return;
    }
    if (hit.memberId !== me || hit.ambiguous) {
      setCamMsg(`Terdeteksi ${nama(hit.memberId)}${hit.ambiguous ? ' (kurang yakin)' : ''}, bukan ${nama(me)} — keluar lalu masuk lagi, atau coba lagi dengan pencahayaan lebih baik.`);
      return;
    }
    await markAttendance(dateStr(0), me);
    const a = await loadAttendance(dateStr(0), dateStr(0));
    if (a) setAtt(a);
    setUnlocked(true);
    try { sessionStorage.setItem(unlockKey(me), dateStr(0)); } catch { /* abaikan */ }
    ting(990, 0.18); // absen lolos
    setToast({ msg: 'Absen berhasil — checklist & bukti terbuka', kind: 'ok' });
    void ensurePush(me);
    void getGeo().then(setGeo); // siapkan koordinat untuk stempel foto
    setCam(null);
    setCamMsg(null);
  };

  // Konfirmasi identitas hasil pindaian wajah sebelum login benar-benar
  // dieksekusi — user melihat foto+nama match lalu tegas menyatakan
  // "ini saya" atau menolaknya (mencegah insiden salah-login akun orang lain).
  const confirmLogin = () => {
    if (!confirmHit) return;
    const hit = confirmHit;
    setConfirmHit(null);
    setMe(hit.memberId);
    setUnlocked(sessionStorage.getItem(unlockKey(hit.memberId)) === dateStr(0));
    ting(990, 0.18); // masuk
    setToast({ msg: `Login berhasil — selamat datang, ${nama(hit.memberId)}`, kind: 'ok' });
    void ensurePush(hit.memberId);
  };
  const rejectLogin = () => {
    setConfirmHit(null);
    setShowUnknown(true); // "bukan saya" → tawarkan daftar / coba lagi
  };

  const submitSwap = async () => {
    if (target === me) return alert('Pilih rekan tukar yang beda.');
    if (!state) return;
    if (fromDay === toDay) return alert('Hari asal & tujuan harus beda.');
    if (!state.schedule[fromDay]?.includes(me)) return alert(`Kamu tidak piket di ${fromDay}.`);
    if (!state.schedule[toDay]?.includes(target)) return alert(`${nama(target)} tidak piket di ${toDay}.`);
    if (state.fromApi) {
      const ok = await createSwapRemote({ requester: me, target, fromDay, toDay, alasan });
      if (!ok) return alert('Gagal simpan (server mati?).');
    } else {
      const cur = load<SwapRow[]>('piket-swaps', []);
      save('piket-swaps', [{ id: Math.random().toString(36).slice(2, 9), requester: me, target, fromDay, toDay, alasan, status: 'pending', createdAt: Date.now() }, ...cur]);
    }
    setAlasan('');
    void refresh();
  };

  const decide = async (w: SwapRow, approve: boolean) => {
    if (state?.fromApi) {
      const ok = await decideSwapRemote(w.id, approve, me);
      if (!ok) return alert('Gagal (hanya yang diminta / Admin).');
    } else {
      if (me !== w.target && !admin) return alert('Hanya yang diminta / Admin.');
      const cur = load<SwapRow[]>('piket-swaps', []).map((x) =>
        x.id === w.id ? { ...x, status: approve ? ('approved' as const) : ('rejected' as const) } : x);
      save('piket-swaps', cur);
      if (approve && state) {
        const sch = { ...state.schedule };
        sch[w.fromDay] = sch[w.fromDay].map((m) => (m === w.requester ? w.target : m));
        sch[w.toDay] = sch[w.toDay].map((m) => (m === w.target ? w.requester : m));
        save('piket-schedule', sch);
      }
    }
    void refresh();
  };

  const cancelSwap = async (w: SwapRow) => {
    if (!confirm('Batalkan pengajuan ini?')) return;
    if (state?.fromApi) {
      const ok = await cancelSwapRemote(w.id, me);
      if (!ok) return alert('Gagal membatalkan.');
    } else {
      save('piket-swaps', load<SwapRow[]>('piket-swaps', []).map((x) =>
        x.id === w.id ? { ...x, status: 'cancelled' as const } : x));
    }
    void refresh();
  };

  const addTo = async (day: DayKey, id: string) => {
    if (!state) return;
    if (state.schedule[day].includes(id)) return;
    const sch = { ...state.schedule, [day]: [...state.schedule[day], id] };
    setState({ ...state, schedule: sch });
    if (state.fromApi) await saveRosterRemote(sch, state.jam);
    else save('piket-schedule', sch);
  };
  const removeFrom = async (day: DayKey, id: string) => {
    if (!state) return;
    const sch = { ...state.schedule, [day]: state.schedule[day].filter((m) => m !== id) };
    setState({ ...state, schedule: sch });
    if (state.fromApi) await saveRosterRemote(sch, state.jam);
    else save('piket-schedule', sch);
  };

  const jamColon = (day: DayKey, idx: 0 | 1): string => {
    const parts = (state?.jam[day] ?? '09.00–15.00').split('–');
    return (parts[idx] ?? (idx === 0 ? '09.00' : '15.00')).replace('.', ':');
  };

  const setJam = async (day: DayKey, which: 'mulai' | 'selesai', colon: string) => {
    if (!state || !/^\d{2}:\d{2}$/.test(colon)) return;
    const dot = colon.replace(':', '.');
    const [m, s] = (state.jam[day] ?? '09.00–15.00').split('–');
    const next = {
      ...state.jam,
      [day]: which === 'mulai' ? `${dot}–${s ?? '15.00'}` : `${m ?? '09.00'}–${dot}`,
    };
    setState({ ...state, jam: next });
    if (state.fromApi) await saveRosterRemote(state.schedule, next);
  };

  // ---- Drag-drop jadwal minggu depan/seterusnya (weekOff !== 0) ----
  // Pindah 1 anggota dari satu hari ke hari lain di draft lokal (belum tersimpan
  // ke server — user masih bisa cancel). Anggota yang sama tidak boleh dobel di 1 hari.
  const moveWeekMember = (memberId: string, fromDay: DayKey, toDay: DayKey) => {
    if (fromDay === toDay) return;
    setDragSchedule((prev) => {
      if (!prev) return prev;
      if (prev[toDay].includes(memberId)) return prev; // sudah ada di hari tujuan
      return {
        ...prev,
        [fromDay]: prev[fromDay].filter((id) => id !== memberId),
        [toDay]: [...prev[toDay], memberId],
      };
    });
    setDragDirty(true);
  };

  const saveWeekDrag = async () => {
    if (!dragSchedule) return;
    setDragSaving(true);
    const ok = await saveWeekRosterRemote(weekDates[0], dragSchedule, weekJamRow);
    setDragSaving(false);
    if (!ok) return alert('Gagal simpan (server mati / bukan Admin?).');
    setWeekSchedule(dragSchedule);
    setWeekOverridden(true);
    setDragDirty(false);
    setToast({ msg: `Jadwal minggu ${rangeLabel} tersimpan.`, kind: 'ok' });
  };

  const resetWeekDrag = () => {
    if (!weekSchedule) return;
    setDragSchedule(weekSchedule);
    setDragDirty(false);
  };

  // Buang override minggu ini → kembali mengikuti template dasar.
  const clearWeekOverride = async () => {
    if (!confirm(`Hapus susunan khusus minggu ${rangeLabel}? Minggu ini kembali mengikuti jadwal dasar.`)) return;
    const ok = await clearWeekRosterRemote(weekDates[0]);
    if (!ok) return alert('Gagal (bukan Admin?).');
    const w = await loadWeekRoster(weekDates[0]);
    if (w) {
      setWeekSchedule(w.schedule);
      setWeekJamRow(w.jam);
      setWeekOverridden(w.overridden);
      setDragSchedule(w.schedule);
      setDragDirty(false);
    }
    setToast({ msg: `Minggu ${rangeLabel} kembali ke jadwal dasar.`, kind: 'info' });
  };

  const gearClick = () => {
    if (admin) return setAdmin(false); // keluar mode Admin
    if (!state || !state.fromApi) return setAdmin(true); // offline: lokal saja
    setPinInput('');
    setShowPin(true);
  };

  const submitPin = async () => {
    const res = await verifyPin(pinInput);
    if (res === null) {
      // server unreachable → anggap offline, izinkan lokal
      setAdmin(true);
    } else if (res) {
      setAdmin(true);
    } else {
      return alert('PIN salah.');
    }
    setShowPin(false);
    setPinInput('');
  };

  const enableNotif = async () => {
    if (!('Notification' in window)) return alert('Browser tidak dukung notifikasi.');
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      if (me) void ensurePush(me);
      new Notification('Ki Menwa USB YPKP', {
        body: tmr === 'Libur' ? 'Besok libur, tidak ada piket.'
          : (state?.schedule[tmr] ?? []).includes(me)
            ? `H-1: besok (${tmr}) giliran kamu piket!` : `Besok (${tmr}) bukan giliranmu. Aman.`,
      });
    }
  };

  useEffect(() => {
    const h = () => setHash(location.hash);
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  useEffect(() => {
    // Bottom nav: sembunyi saat scroll turun, muncul saat scroll naik / idle.
    let lastY = window.scrollY;
    let t: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      const y = window.scrollY;
      if (y > lastY + 4 && y > 80) setNavHidden(true);
      else if (y < lastY - 4) setNavHidden(false);
      lastY = y;
      if (t) clearTimeout(t);
      t = setTimeout(() => setNavHidden(false), 1500);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (t) clearTimeout(t);
    };
  }, []);
  // Pintu dev: tap judul 5× → dashboard superadmin.
  const titleTap = () => {
    setTitleTaps((n) => {
      if (n + 1 >= 5) {
        location.hash = 'super';
        return 0;
      }
      return n + 1;
    });
  };
  return {
    tab, setTab, state, checks, ev, uploadingTugas, pendingTugas, photoRef,
    preview, setPreview, weekEv, geo, members, meMember, nama, warna,
    today, tmr, crew, crewBesok, jamHari, jamSelesaiHariIni, lapsitOpenAt, lapsitOpen,
    doneCount, pending, incoming, outgoing, othersPending, approvedSwaps, swappedDays,
    bellDot, ABBR, weekDates, rangeLabel, putarRotasi, dayDate, mySlots,
    taskTap, onFile, pickPhoto, toggleBd, kirimLapsit, needVerify, onSelfieAbsen,
    loginCam, logout, onProfileDone, finishRegister, handleDuplicate, handleEnroll,
    handleDescriptor, confirmLogin, rejectLogin, confirmHit,
    submitSwap, decide, cancelSwap, addTo, removeFrom, jamColon, setJam,
    moveWeekMember, saveWeekDrag, resetWeekDrag, clearWeekOverride,
    gearClick, submitPin, enableNotif, titleTap, hash,
    admin, showPin, setShowPin, pinInput, setPinInput, online,
    target, setTarget, fromDay, setFromDay, toDay, setToDay, alasan, setAlasan,
    weekOff, setWeekOff, weekStat, expanded, setExpanded, pickDay, setPickDay,
    weekLoading, dragSchedule, dragDirty, dragSaving, weekOverridden,
    me, setMe, faces, att, unlocked, cam, setCam, camMsg, setCamMsg,
    toast, setToast, profiling, setProfiling, showUnknown, setShowUnknown,
    navHidden, showLogout, setShowLogout, pinNew, setPinNew, pinMsg, setPinMsg, savePin,
    avatarBusy, avatarInputRef, selfieInputRef, onAvatarFile, removeAvatar, pinLogin,
    lapsit, lapsitText, setLapsitText, bdOpen, setBdOpen, buktiOpen, setBuktiOpen,
    bdDone, bdSecOpen, setBdSecOpen, nilaiHariIni,
  };
}

export type AppStore = ReturnType<typeof useAppStore>;
