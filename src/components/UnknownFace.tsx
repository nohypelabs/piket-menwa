import { motion } from 'framer-motion';

export function UnknownFace({ onRegister, onClose }: {
  onRegister: () => void; onClose: () => void;
}) {
  return (
    <motion.div
      className="preview" onClick={onClose}
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
        <b>Wajah belum terdaftar</b>
        <span className="hint">Sistem tidak mengenali wajahmu. Silakan daftar terlebih dahulu.</span>
        <div className="row">
          <button className="primary" onClick={onRegister}>Registrasi</button>
          <button onClick={onClose}>Tutup</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
