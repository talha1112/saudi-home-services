"use client";

import type { ReactNode } from "react";

const BOX = "rounded-[11px] border-[1.5px] border-line bg-white";

/** Label + control stack. Set `rtl` for the Arabic column of a bilingual pair. */
export function Field({ label, children, rtl = false, className = "" }: { label: string; children: ReactNode; rtl?: boolean; className?: string }) {
  return (
    <label dir={rtl ? "rtl" : undefined} className={`flex flex-col gap-1.5 ${rtl ? "font-arabic" : ""} ${className}`}>
      <span className={rtl ? "text-[13px] font-bold" : "text-[12.5px] font-semibold"}>{label}</span>
      {children}
    </label>
  );
}

interface TextProps {
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  rtl?: boolean;
  bold?: boolean;
  className?: string;
}

export function TextInput({ value, onChange, placeholder, rtl, bold, className = "" }: TextProps) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
      className={`h-[42px] px-3 ${BOX} ${rtl ? "font-arabic text-[15px]" : "text-sm"} ${bold ? "font-semibold" : ""} ${className}`}
    />
  );
}

export function TextArea({ value, onChange, placeholder, rtl, height = 72, className = "" }: TextProps & { height?: number }) {
  return (
    <textarea
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
      className={`resize-none px-3 py-2.5 ${BOX} ${rtl ? "font-arabic text-sm" : "text-[13.5px]"} ${className}`}
      style={{ height }}
    />
  );
}

/** Read-only display box that looks like an input. */
export function StaticBox({ children, className = "", rtl }: { children: ReactNode; className?: string; rtl?: boolean }) {
  return (
    <div className={`flex min-h-[42px] items-center px-3 text-sm ${BOX} ${rtl ? "font-arabic text-[15px]" : ""} ${className}`}>{children}</div>
  );
}

/** Input with a unit prefix/suffix inside the border. */
export function UnitInput({ value, onChange, prefix, suffix, placeholder }: { value: string; onChange: (v: string) => void; prefix?: string; suffix?: string; placeholder?: string }) {
  return (
    <div className={`flex h-[42px] items-center overflow-hidden ${BOX}`}>
      {prefix && <span className="px-2.5 text-[12.5px] font-semibold text-slate">{prefix}</span>}
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`min-w-0 flex-1 border-none bg-transparent text-sm font-semibold ${prefix ? "" : "px-3"}`}
      />
      {suffix && <span className="px-2.5 text-[12.5px] font-semibold text-slate">{suffix}</span>}
    </div>
  );
}
