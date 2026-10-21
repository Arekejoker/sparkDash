import type { ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose?: () => void;
  children: ReactNode;
}

/** Minimal centered modal overlay for interactive dialogs. */
export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <span className="text-sm font-medium text-text-strong">{title}</span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded px-2 py-0.5 text-base leading-none text-muted hover:bg-surface-hover hover:text-text"
              aria-label="Close"
            >
              ×
            </button>
          )}
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
