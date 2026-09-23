import { useState } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, closestCenter,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { GripVertical } from 'lucide-react';
import { DAYS, dateStr } from '../piket';
import type { Member } from '../api';
import type { DayKey } from '../piket';

// ---- Drag-drop jadwal mingguan (minggu depan/seterusnya) ----
// Kartu anggota yang bisa di-drag antar kolom hari. Dipakai di dalam
// DndContext (lihat WeekDragBoard) — posisi ditata pakai @dnd-kit/core murni
// (bukan sortable list) karena tujuannya pindah kartu ANTAR kolom, bukan
// reorder dalam 1 list.
function DragMemberCard({ id, nama, warna, foto, disabled }: {
  id: string; nama: string; warna: string; foto: string | null; disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id, disabled });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50 }
    : undefined;
  const firstName = nama.split(' ')[0];
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`dragcard ${isDragging ? 'dragging' : ''}`}
      title={nama}
      {...attributes}
      {...listeners}
    >
      {foto
        ? <img className="ava" src={foto} alt={nama} />
        : <i className="pdot" style={{ background: warna }} />}
      <span>{firstName}</span>
      {!disabled && <GripVertical size={11} className="griphandle" />}
    </div>
  );
}

// Kolom 1 hari — droppable area tempat kartu di-lepas.
function DragDayColumn({ day, abbr, dateNum, isToday, ids, members, disabled }: {
  day: DayKey; abbr: string; dateNum: number; isToday: boolean;
  ids: string[]; members: Member[]; disabled?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: day, disabled });
  return (
    <div ref={setNodeRef} className={`dragcol ${isToday ? 'now' : ''} ${isOver ? 'over' : ''}`}>
      <div className="dragcolhd"><b>{abbr}</b><span>{dateNum}</span></div>
      <div className="dragcolbody">
        {ids.map((id) => {
          const m = members.find((x) => x.id === id);
          return (
            <DragMemberCard
              key={id} id={`${day}::${id}`}
              nama={m?.nama ?? id} warna={m?.warna ?? '#6b7280'} foto={m?.foto ?? null}
              disabled={disabled}
            />
          );
        })}
        {ids.length === 0 && <p className="dragempty">kosong</p>}
      </div>
    </div>
  );
}

// Papan drag-drop 5 kolom (Senin-Jumat) untuk 1 minggu spesifik. State draft
// dikelola di App (dragSchedule) — komponen ini murni UI + DndContext.
export function WeekDragBoard({
  weekLoading, dragSchedule, dragDirty, dragSaving, weekOverridden, weekDates, members,
  onMove, onSave, onReset, onClearOverride,
}: {
  weekLoading: boolean; dragSchedule: Record<DayKey, string[]> | null;
  dragDirty: boolean; dragSaving: boolean; weekOverridden: boolean;
  weekDates: string[]; members: Member[];
  onMove: (memberId: string, fromDay: DayKey, toDay: DayKey) => void;
  onSave: () => void; onReset: () => void; onClearOverride: () => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
  );
  const ABBR2 = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum'];
  const today = dateStr(0);

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const [fromDay, memberId] = String(active.id).split('::') as [DayKey, string];
    const toDay = over.id as DayKey;
    onMove(memberId, fromDay, toDay);
  };

  if (weekLoading || !dragSchedule) {
    return <p className="hint">Memuat jadwal minggu ini…</p>;
  }

  const activeMemberId = activeId ? activeId.split('::')[1] : null;
  const activeMember = members.find((m) => m.id === activeMemberId);

  return (
    <div className="dragboard">
      <p className="hint">
        <GripVertical size={12} /> Seret kartu anggota antar hari untuk atur jadwal minggu ini.
        {weekOverridden && <> Minggu ini punya susunan khusus (beda dari jadwal dasar).</>}
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="dragcols">
          {DAYS.map((d, i) => (
            <DragDayColumn
              key={d} day={d} abbr={ABBR2[i]}
              dateNum={new Date(weekDates[i] + 'T00:00').getDate()}
              isToday={weekDates[i] === today}
              ids={dragSchedule[d]} members={members}
              disabled={dragSaving}
            />
          ))}
        </div>
        <DragOverlay>
          {activeMember && (
            <div className="dragcard dragging overlay">
              {activeMember.foto
                ? <img className="ava" src={activeMember.foto} alt={activeMember.nama} />
                : <i className="pdot" style={{ background: activeMember.warna }} />}
              <span>{activeMember.nama}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
      <div className="dragactions">
        <button className="ghostbtn sm" onClick={onReset} disabled={!dragDirty || dragSaving}>Batal</button>
        {weekOverridden && (
          <button className="ghostbtn sm danger" onClick={onClearOverride} disabled={dragSaving}>
            Kembalikan ke dasar
          </button>
        )}
        <button className="primary sm" onClick={onSave} disabled={!dragDirty || dragSaving}>
          {dragSaving ? 'Menyimpan…' : 'Simpan jadwal minggu ini'}
        </button>
      </div>
    </div>
  );
}
