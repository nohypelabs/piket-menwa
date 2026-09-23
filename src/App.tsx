import { AnimatePresence, motion } from 'framer-motion';
import { matchFace } from './api';
import { useAppStore } from './hooks/useAppStore';
import { AppHeader } from './components/AppHeader';
import { BottomTabs } from './components/BottomTabs';
import { ConfirmIdentity } from './components/ConfirmIdentity';
import { FaceCam } from './components/FaceCam';
import { LogoutSheet } from './components/LogoutSheet';
import { PhotoPreview } from './components/PhotoPreview';
import { PinSheet } from './components/PinSheet';
import { Toast } from './components/Toast';
import { UnknownFace } from './components/UnknownFace';
import { HariTab } from './tabs/HariTab';
import { MingguanTab } from './tabs/MingguanTab';
import { TukarTab } from './tabs/TukarTab';
import { ProfilePage, WelcomePage } from './Welcome';
import SuperView from './Super';

export default function App() {
  const store = useAppStore();
  const {
    tab, setTab, hash, meMember, members, profiling, cam, camMsg, toast,
    showUnknown, confirmHit, admin, showPin, showLogout,
    preview, me, checks, doneCount, navHidden, pending, state, online, bellDot,
  } = store;

  const camModal = cam && (
    <FaceCam
      title={cam.mode === 'register'
        ? 'Daftar anggota baru'
        : cam.mode === 'login'
          ? 'Masuk dengan wajah'
          : `Absen ${store.nama(me)}`}
      note={camMsg}
      enroll={cam.mode === 'register'}
      onShot={(d) => void store.handleDescriptor(d)}
      onEnroll={(ds) => void store.handleEnroll(ds)}
      onClose={() => { store.setCam(null); store.setCamMsg(null); }}
      onRescan={() => store.setCamMsg(null)}
      onDuplicate={store.handleDuplicate}
      checkDuplicate={matchFace}
      onPinLogin={async (pin) => {
        const r = await store.pinLogin(pin);
        if (r.ok) {
          store.setCam(null);
          store.setCamMsg(null);
        }
        return r;
      }}
    />
  );

  if (hash === '#super') {
    return (
      <div className="phone wide tac">
        <SuperView onExit={() => { location.hash = ''; }} />
      </div>
    );
  }

  // Gate: belum masuk → welcome / form profil. Daily page hanya utk yg login.
  if (!meMember) {
    return (
      <div className="phone tac">
        {profiling
          ? <ProfilePage onDone={store.onProfileDone} onCancel={() => store.setProfiling(false)} names={members.map((m) => m.nama)} existing={members.map((m) => ({ nama: m.nama, angkatan: m.angkatan }))} />
          : <WelcomePage onTap={store.loginCam} onRegister={() => store.setProfiling(true)} onPinLogin={store.pinLogin} />}
        <AnimatePresence>
          {showUnknown && (
            <UnknownFace onRegister={() => { store.setShowUnknown(false); store.setProfiling(true); }} onClose={() => store.setShowUnknown(false)} />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {confirmHit && (
            <ConfirmIdentity
              hit={confirmHit}
              members={members}
              onYes={store.confirmLogin}
              onNo={store.rejectLogin}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>{camModal}</AnimatePresence>
        <AnimatePresence>
          {toast && <Toast t={toast} onClose={() => store.setToast(null)} />}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="phone tac">
      <AppHeader
        tab={tab}
        membersCount={members.length}
        offline={!online || state?.fromApi === false}
        admin={admin}
        bellDot={bellDot}
        onTitleTap={store.titleTap}
        onGear={store.gearClick}
        onBell={store.enableNotif}
        avatar={meMember.foto
          ? <img src={meMember.foto} alt={meMember.nama} />
          : <i className="pdot" style={{ background: meMember.warna }} />}
        onAvatar={() => store.setShowLogout(true)}
      />
      <AnimatePresence>
        {showPin && (
          <PinSheet
            pinInput={store.pinInput}
            setPinInput={store.setPinInput}
            submitPin={store.submitPin}
            onClose={() => store.setShowPin(false)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showLogout && (
          <LogoutSheet
            member={meMember}
            pinNew={store.pinNew}
            setPinNew={store.setPinNew}
            pinMsg={store.pinMsg}
            setPinMsg={store.setPinMsg}
            onSavePin={store.savePin}
            avatarBusy={store.avatarBusy}
            avatarInputRef={store.avatarInputRef}
            onAvatarFile={(f) => void store.onAvatarFile(f)}
            onRemoveAvatar={() => void store.removeAvatar()}
            onLogout={store.logout}
            onClose={() => store.setShowLogout(false)}
          />
        )}
      </AnimatePresence>

      <main>
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {tab === 'hari' && <HariTab store={store} />}
            {tab === 'minggu' && <MingguanTab store={store} />}
            {tab === 'tukar' && <TukarTab store={store} />}
          </motion.div>
        </AnimatePresence>
      </main>

      {tab === 'hari' && checks.length > 0 && (
        <div className="progress"><i style={{ width: `${(doneCount / checks.length) * 100}%` }} /></div>
      )}
      <AnimatePresence>{camModal}</AnimatePresence>
      <input
        ref={store.selfieInputRef} type="file" accept="image/*" capture="user" hidden
        onChange={(e) => { void store.onSelfieAbsen(e.target.files?.[0]); e.target.value = ''; }}
      />
      <AnimatePresence>
        {toast && <Toast t={toast} onClose={() => store.setToast(null)} />}
      </AnimatePresence>
      <AnimatePresence>
        {preview && (
          <PhotoPreview
            preview={preview}
            isAdmin={admin}
            viewerName={store.nama(me ?? '')}
            onClose={() => store.setPreview(null)}
          />
        )}
      </AnimatePresence>
      <BottomTabs tab={tab} onTab={setTab} pendingCount={pending.length} hidden={navHidden} />
    </div>
  );
}
