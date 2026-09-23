import { motion } from 'framer-motion';
import { Check, Info, TriangleAlert } from 'lucide-react';

// Toast global (error/info/ok) dengan animasi framer-motion.
export function Toast({ t, onClose }: { t: { msg: string; kind: 'error' | 'ok' | 'info' }; onClose: () => void }) {
  return (
    <motion.div
      className={`toast ${t.kind}`} onClick={onClose}
      initial={{ opacity: 0, y: -14, x: '-50%' }}
      animate={{ opacity: 1, y: 0, x: '-50%' }}
      exit={{ opacity: 0, y: -14, x: '-50%' }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
    >
      {t.kind === 'ok' ? <Check size={16} /> : t.kind === 'info' ? <Info size={16} /> : <TriangleAlert size={16} />} {t.msg}
    </motion.div>
  );
}
