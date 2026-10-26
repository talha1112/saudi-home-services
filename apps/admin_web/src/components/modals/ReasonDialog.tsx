"use client";

import { useState } from "react";
import { Modal } from "./Modal";

interface ReasonDialogProps {
  title: string;
  subtitle: string;
  cta: string;
  /** When true the reason cannot be empty (the backend requires it for reject, request-info and suspend). */
  required: boolean;
  /** Footer text; defaults to the worker wording. */
  hint?: string;
  onClose: () => void;
  /** Resolves when done; throw to keep the dialog open and show the message. */
  onConfirm: (reason: string) => Promise<void>;
}

/** Asks for a short reason (shown to the worker) and runs the action; a failure stays visible inside the dialog. */
export function ReasonDialog({ title, subtitle, cta, required, hint, onClose, onConfirm }: ReasonDialogProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = !busy && (!required || reason.trim().length > 0);

  async function submit() {
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <Modal title={title} subtitle={subtitle} icon="shield" width={480} hint={hint ?? (required ? "A reason is required and is shown to the worker." : "Optional note.")} cta={busy ? "Working…" : cta} canSubmit={ok} onClose={onClose} onSubmit={submit}>
      <textarea
        autoFocus
        value={reason}
        maxLength={1000}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason"
        className="min-h-28 resize-none rounded-xl border-[1.5px] border-line px-3 py-2.5 text-[13.5px]"
      />
      {error && (
        <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-3 py-2.5 text-[13px] text-danger">
          {error}
        </div>
      )}
    </Modal>
  );
}
