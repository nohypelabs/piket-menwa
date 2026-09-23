import { motion } from 'framer-motion';
import type { RefObject } from 'react';
import type { Member } from '../api';

export function LogoutSheet({ member, pinNew, setPinNew, pinMsg, setPinMsg, onSavePin, avatarBusy, avatarInputRef, onAvatarFile, onRemoveAvatar, onLogout, onClose }: {
  member: Member;
  pinNew: string; setPinNew: (v: string) => void; pinMsg: string | null; setPinMsg: (v: string | null) => void;
  onSavePin: () => void; avatarBusy: boolean;
  avatarInputRef: RefObject<HTMLInputElement | null>;
  onAvatarFile: (f: File | undefined) => void; onRemoveAvatar: () => void;
  onLogout: () => void; onClose: () => void;
}) {
  return (
    <motion.div
      className="sheetwrap" onClick={onClose}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="sheet" onClick={(e) => e.stopPropagation()}
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'tween', duration: 0.28, ease: 'easeOut' }}
        drag="y" dragConstraints={{ top: 0, bottom: 0 }} dragElastic={0.25}
        onDragEnd={(_, info) => {
          if (info.offset.y > 90 || info.velocity.y > 500) onClose();
        }}
      >
        <i className="grabber" />
        {member.foto
          ? <img className="sheetava" src={member.foto} alt={member.nama} />
          : <i className="pdot big" style={{ background: member.warna }} />}
        <input
          ref={avatarInputRef} type="file" accept="image/*" hidden
          onChange={(e) => void onAvatarFile(e.target.files?.[0])}
        />
        <div className="avatarrow">
          <button className="ghostbtn sm" disabled={avatarBusy} onClick={() => avatarInputRef.current?.click()}>
            {avatarBusy ? 'memproses…' : member.foto ? 'Ganti foto profil' : 'Tambah foto profil'}
          </button>
          {member.foto && (
            <button className="ghostbtn sm" disabled={avatarBusy} onClick={() => void onRemoveAvatar()}>Hapus foto</button>
          )}
        </div>
        <b>{member.nama}</b>
        <span className="hint">{[member.jabatan, member.angkatan].filter(Boolean).join(' · ')}</span>
        <div className="pinrow">
          <input
            type="password" inputMode="numeric" maxLength={12}
            placeholder="PIN baru (min 6 digit)" value={pinNew}
            onChange={(e) => { setPinNew(e.target.value.replace(/\D/g, '').slice(0, 12)); setPinMsg(null); }}
          />
          <button onClick={onSavePin}>Simpan PIN</button>
          {pinMsg && <span className="pinmsg">{pinMsg}</span>}
        </div>
        <button className="danger" onClick={onLogout}>Logout</button>
        <button className="ghostbtn" onClick={onClose}>Batal</button>
      </motion.div>
    </motion.div>
  );
}
