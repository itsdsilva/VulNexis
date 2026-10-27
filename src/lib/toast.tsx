// Tiny global toast store: call toast('...', 'success') from anywhere.
// Rendered once by <Toaster /> in App.

import { useSyncExternalStore } from 'react';

export type ToastKind = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function toast(text: string, kind: ToastKind = 'info', ttl = 3400) {
  const id = nextId++;
  items = [...items, { id, text, kind }];
  emit();
  window.setTimeout(() => dismiss(id), ttl);
}

export function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function snapshot() {
  return items;
}

const STYLE: Record<ToastKind, string> = {
  info: 'border-accent-cyan/40 text-text-primary',
  success: 'border-accent-green/50 text-accent-green',
  error: 'border-accent-red/50 text-accent-red',
};

export function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (list.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {list.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto max-w-sm bg-bg-elevated/95 backdrop-blur border rounded-lg px-3.5 py-2.5 text-xs shadow-pop tracking-[0.01em] ${STYLE[t.kind]}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
