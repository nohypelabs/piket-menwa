import { motion } from 'framer-motion';
import type { PreviewState } from '../hooks/useAppStore';

export function PhotoPreview({ preview, isAdmin, viewerName, onClose }: {
  preview: PreviewState; isAdmin: boolean; viewerName: string; onClose: () => void;
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
        <div className="wmwrap">
          <img src={preview.file} alt={preview.judul} />
          {isAdmin && preview.by !== viewerName && (
            <span className="wm">{viewerName || 'Admin'} • {new Date().toLocaleString('id-ID')}</span>
          )}
        </div>
        <b>{preview.judul}</b>
        <span className="hint">oleh {preview.by} • {preview.tanggal.split('-').reverse().join('/')} • final, tidak bisa diubah</span>
        <div className="row">
          <button className="primary" onClick={onClose}>Tutup</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
