import { motion } from 'framer-motion';
import type { Member } from '../api';

export function ConfirmIdentity({ hit, members, onYes, onNo }: {
  hit: { memberId: string; ambiguous: boolean }; members: Member[];
  onYes: () => void; onNo: () => void;
}) {
  const cand = members.find((m) => m.id === hit.memberId);
  return (
    <motion.div
      className="preview"
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
        <b>{hit.ambiguous ? 'Kurang yakin — ini kamu?' : 'Konfirmasi identitas'}</b>
        <div className="confirmid">
          {cand?.foto
            ? <img className="ava lg" src={cand.foto} alt={cand?.nama ?? ''} />
            : <i className="pdot lg" style={{ background: cand?.warna ?? '#6b7280' }} />}
          <span>{cand?.nama ?? hit.memberId}</span>
        </div>
        <span className="hint">
          {hit.ambiguous
            ? 'Wajahmu mirip lebih dari 1 orang terdaftar. Pastikan benar sebelum lanjut — kalau ragu, pilih "Bukan saya" dan coba pindai ulang dengan pencahayaan lebih baik.'
            : 'Cek foto & nama di atas — ini kamu?'}
        </span>
        <div className="row">
          <button className="primary" onClick={onYes}>Ya, ini saya</button>
          <button onClick={onNo}>Bukan saya</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
