"use client";

import type { ReactNode } from "react";

export function CardInspectModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xs rounded-lg border-4 border-gilt bg-tavern-panel p-4 shadow-[0_0_0_1px_theme(colors.gilt.dark),0_8px_24px_rgb(0_0_0_/_0.6)]"
      >
        {children}
      </div>
    </div>
  );
}
