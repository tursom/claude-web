import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import './layout.css';

export interface ResizeHandleProps {
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  onWidth: (n: number) => void;
  onOpen: (open: boolean) => void;
}

export function ResizeHandle({ side, width, min, max, onWidth, onOpen }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ open: boolean; finish: () => void } | null>(null);
  const mounted = useRef(true);
  const clamp = (value: number) => Math.max(min, Math.min(Math.max(min, max), value));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A parent may unmount the closed panel. Keep this gesture alive until
      // pointer-up so dragging back can reopen it through the controlled callback.
      if (drag.current?.open) drag.current.finish();
    };
  }, []);

  function start(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || !window.matchMedia('(min-width: 1024px)').matches) return;
    event.preventDefault();
    drag.current?.finish();
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    element.focus();
    element.setPointerCapture(pointerId);
    const body = document.body;
    const selection = body.style.getPropertyValue('user-select');
    const selectionPriority = body.style.getPropertyPriority('user-select');
    const cursor = body.style.getPropertyValue('cursor');
    const cursorPriority = body.style.getPropertyPriority('cursor');
    body.style.setProperty('user-select', 'none', 'important');
    body.style.setProperty('cursor', 'col-resize', 'important');
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', finish);
      if (selection) body.style.setProperty('user-select', selection, selectionPriority);
      else body.style.removeProperty('user-select');
      if (cursor) body.style.setProperty('cursor', cursor, cursorPriority);
      else body.style.removeProperty('cursor');
      drag.current = null;
      if (mounted.current) setDragging(false);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId || !drag.current) return;
      const next = width + (moveEvent.clientX - startX) * (side === 'left' ? 1 : -1);
      const open = next >= min - 60;
      onWidth(clamp(next));
      if (drag.current.open !== open) {
        drag.current.open = open;
        onOpen(open);
      }
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) finish();
    };
    drag.current = { open: true, finish };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', finish);
    setDragging(true);
  }

  return (
    <div
      className={`cw-resize-handle cw-resize-${side}${dragging ? ' cw-resize-dragging' : ''}`}
      role="separator"
      aria-label={side === 'left' ? '侧栏宽度' : '面板宽度'}
      aria-orientation="vertical"
      aria-valuenow={Math.round(clamp(width))}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, max)}
      tabIndex={0}
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={start}
      onLostPointerCapture={() => {
        if (mounted.current && drag.current?.open) drag.current.finish();
      }}
      onDoubleClick={() => {
        onWidth(clamp(side === 'left' ? 280 : 480));
        onOpen(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const direction = event.key === 'ArrowRight' ? 1 : -1;
          onWidth(clamp(width + direction * (side === 'left' ? 1 : -1) * 16));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          onOpen(false);
        }
      }}
    />
  );
}

export default ResizeHandle;
