import { Bell, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Tab } from '../hooks/useAppStore';

const tabTitle: Record<Tab, string> = {
  hari: 'Jadwal Piket Hari Ini',
  minggu: 'Jadwal Mingguan',
  tukar: 'Tukar Jadwal',
};

export function AppHeader({ tab, membersCount, offline, admin, bellDot, onTitleTap, onGear, onBell, avatar, onAvatar }: {
  tab: Tab; membersCount: number; offline: boolean; admin: boolean; bellDot: boolean;
  onTitleTap: () => void; onGear: () => void; onBell: () => void;
  avatar: ReactNode; onAvatar: () => void;
}) {
  return (
    <>
      <header className="hd">
        {avatar && (
          <button className="hdavatar" onClick={onAvatar} title="profil">
            {avatar}
          </button>
        )}
        <div onClick={onTitleTap}>
          <h1>{tabTitle[tab]}</h1>
          <p>Ki Menwa YPKP • {membersCount} anggota{offline ? ' • offline' : ''}</p>
        </div>
        <div className="hbtns">
          <button className="iconbtn" onClick={onGear} title="mode Admin"><Settings size={19} /></button>
          <button className="iconbtn bell" onClick={onBell} title="pengingat H-1">
            <Bell size={19} />{bellDot && <i className="dot" />}
          </button>
        </div>
      </header>
      {offline && <div className="offline">● offline — data lokal</div>}
      {admin && <div className="adminbar">mode Admin aktif — kelola di tab Mingguan/Tukar</div>}
    </>
  );
}
