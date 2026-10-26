"use client";

import type { ReactNode } from "react";
import type { Tone } from "@/types";
import { Icon } from "./Icon";

export const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-tint text-brand",
  warn: "bg-cream text-[#8a5b00]",
  bad: "bg-danger-bg text-danger",
  neutral: "bg-soft text-[#334155]",
  dark: "bg-ink text-gold",
};

/** Tones for labels that are not given one. */
const LABEL_TONE: Record<string, Tone> = {
  Active: "ok", Paid: "ok", Completed: "ok", Confirmed: "neutral", Accepted: "ok", Published: "ok", Sent: "ok", "In progress": "ok", Approved: "ok", Resolved: "ok",
  Suspended: "bad", Failed: "bad", Rejected: "bad", Flagged: "bad", Cancelled: "neutral", Refunded: "warn", Pending: "warn", Expired: "neutral", Inactive: "neutral", Scheduled: "warn", Draft: "neutral",
};
const toneOf = (label: string): Tone => LABEL_TONE[label] ?? "neutral";

/** Small rounded status label. Pass `tone` or let it derive from the label. */
export function Badge({ label, tone, className = "" }: { label: string; tone?: Tone; className?: string }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-lg px-[9px] py-1 text-xs font-bold ${TONE_CLASS[tone ?? toneOf(label)]} ${className}`}>
      {label}
    </span>
  );
}

export function Avatar({ text, size = 32, round = false, className = "" }: { text: string; size?: number; round?: boolean; className?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center bg-tint font-bold text-brand ${round ? "rounded-full" : ""} ${className}`}
      style={{ width: size, height: size, borderRadius: round ? undefined : size * 0.31, fontSize: size * 0.37 }}
    >
      {text}
    </span>
  );
}

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "outline" | "soft" | "dark" | "gold" | "danger";
  icon?: string;
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit";
}

const VARIANT: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-brand text-white border-transparent",
  outline: "bg-white text-ink border-line border",
  soft: "bg-tint text-brand border-transparent",
  dark: "bg-ink text-white border-transparent",
  gold: "bg-cream text-[#8a5b00] border-transparent",
  danger: "bg-white text-danger border-[1.5px] border-danger-line",
};

export function Button({ children, onClick, variant = "primary", icon, className = "", disabled, type = "button" }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold ${VARIANT[variant]} ${disabled ? "cursor-not-allowed opacity-60" : ""} ${className}`}
    >
      {icon && <Icon name={icon} size={15} />}
      {children}
    </button>
  );
}

/** Segmented control with a white thumb on the active option. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  className = "",
  height = 36,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  height?: number;
}) {
  return (
    <div className={`grid gap-[3px] rounded-[11px] bg-soft p-[3px] ${className}`} style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-[9px] text-[13px] font-semibold ${value === o.value ? "bg-white text-ink shadow-[0_1px_3px_rgba(23,43,53,.12)]" : "text-slate"}`}
          style={{ height }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Selectable pill, teal-tinted when selected. */
export function Chip({ label, selected, onClick, icon, className = "" }: { label: string; selected: boolean; onClick: () => void; icon?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-[34px] items-center gap-[5px] rounded-full border-[1.5px] px-3 text-[13px] font-semibold ${selected ? "border-[#9cc5ba] bg-tint text-brand" : "border-line bg-white text-ink"} ${className}`}
    >
      {icon && <Icon name={icon} size={14} />}
      {label}
    </button>
  );
}

export function Toggle({ on, onChange, small = false }: { on: boolean; onChange?: (v: boolean) => void; small?: boolean }) {
  const w = small ? 42 : 44;
  const h = small ? 24 : 26;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange?.(!on)}
      className={`flex shrink-0 rounded-full p-[3px] ${on ? "justify-end bg-brand" : "justify-start bg-[#d5dde2]"}`}
      style={{ width: w, height: h }}
    >
      <span className="rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.2)]" style={{ width: h - 6, height: h - 6 }} />
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[18px] border border-hair bg-white ${className}`}>{children}</div>;
}

export function CardTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-[15.5px] font-bold">{children}</div>
      {aside}
    </div>
  );
}

export function LinkButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className="border-none bg-transparent text-[13px] font-semibold text-brand">
      {children}
    </button>
  );
}

export function Stars({ n }: { n: number }) {
  return <span className="font-bold text-[#d9a43a]">{"★".repeat(n) + "☆".repeat(5 - n)}</span>;
}
