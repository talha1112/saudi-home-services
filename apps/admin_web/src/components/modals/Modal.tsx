"use client";

import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";

interface ModalProps {
  title: string;
  subtitle: string;
  icon: string;
  width: number;
  hint: string;
  cta: string;
  canSubmit: boolean;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}

/** Centered dialog with header, scrollable body and footer actions. */
export function Modal({ title, subtitle, icon, width, hint, cta, canSubmit, onClose, onSubmit, children }: ModalProps) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(23,43,53,.45)] p-8" onMouseDown={onClose}>
      <div
        className="flex max-h-full flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_30px_80px_rgba(23,43,53,.3)]"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3.5 border-b border-soft px-[22px] py-5">
          <span className="grid size-[42px] shrink-0 place-items-center rounded-[13px] bg-tint text-brand">
            <Icon name={icon} size={20} />
          </span>
          <div className="flex flex-1 flex-col gap-[3px]">
            <b className="text-lg">{title}</b>
            <span className="text-[13px] leading-[1.45] text-slate">{subtitle}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-[34px] place-items-center rounded-[10px] border border-line bg-white">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-[22px] py-5">{children}</div>
        <div className="flex items-center gap-2.5 border-t border-soft bg-[#fafbfc] px-[22px] py-3.5">
          <span className="flex-1 text-[12.5px] text-slate">{hint}</span>
          <Button variant="outline" className="h-[42px]" onClick={onClose}>
            Cancel
          </Button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className={`h-[42px] rounded-xl px-[18px] font-semibold text-white ${canSubmit ? "bg-brand" : "cursor-not-allowed bg-[#a9c4c0]"}`}
          >
            {cta}
          </button>
        </div>
      </div>
    </div>
  );
}
