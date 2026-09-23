import { motion } from 'framer-motion';
import { ArrowLeftRight, CalendarDays, CalendarRange } from 'lucide-react';
import type { Tab } from '../hooks/useAppStore';

export function BottomTabs({ tab, onTab, pendingCount, hidden }: {
  tab: Tab; onTab: (t: Tab) => void; pendingCount: number; hidden: boolean;
}) {
  return (
    <motion.nav
      className="tabs"
      initial={false}
      animate={{ x: '-50%', y: hidden ? '110%' : '0%' }}
      transition={{ type: 'tween', duration: 0.3, ease: 'easeOut' }}
    >
      <button className={tab === 'hari' ? 'on' : ''} onClick={() => onTab('hari')}><CalendarDays size={20} /><span>Hari Ini</span></button>
      <button className={tab === 'minggu' ? 'on' : ''} onClick={() => onTab('minggu')}><CalendarRange size={20} /><span>Mingguan</span></button>
      <button className={tab === 'tukar' ? 'on' : ''} onClick={() => onTab('tukar')}><ArrowLeftRight size={20} /><span>Tukar{pendingCount ? ` (${pendingCount})` : ''}</span></button>
    </motion.nav>
  );
}
