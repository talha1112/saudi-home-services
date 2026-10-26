"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeError, sessionApi } from "@/lib/api";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = again.length > 0 && next !== again;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await sessionApi.changePassword(current, next);
      router.replace("/dashboard");
      router.refresh();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  async function signOut() {
    await sessionApi.logout().catch(() => undefined);
    router.replace("/login");
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4">
      <form onSubmit={submit} className="flex w-full max-w-[420px] flex-col gap-4 rounded-2xl border border-line bg-white p-8 shadow-[0_18px_50px_rgba(23,43,53,.08)]">
        <div>
          <h1 className="text-2xl font-bold">Set a new password</h1>
          <p className="mt-1 text-[13px] text-slate">You must change your password before continuing. 12 to 128 characters, mixing letters with numbers or symbols. You will be signed out of other devices.</p>
        </div>
        {[
          ["Current password", current, setCurrent, "current-password"],
          ["New password", next, setNext, "new-password"],
          ["Repeat new password", again, setAgain, "new-password"],
        ].map(([label, value, set, auto]) => (
          <label key={label as string} className="flex flex-col gap-1.5 text-[12.5px] font-semibold">
            {label as string}
            <input type="password" required autoComplete={auto as string} value={value as string} onChange={(e) => (set as (v: string) => void)(e.target.value)} className="h-11 rounded-[11px] border-[1.5px] border-line px-3 text-sm font-normal" />
          </label>
        ))}
        {mismatch && <div className="text-[13px] text-danger">The new passwords do not match.</div>}
        {error && (
          <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-3 py-2.5 text-[13px] text-danger">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy || mismatch || !current || !next} className="h-11 rounded-xl bg-brand font-semibold text-white disabled:opacity-50">
          {busy ? "Saving…" : "Change password"}
        </button>
        <button type="button" onClick={signOut} className="text-[13px] font-semibold text-slate">
          Sign out
        </button>
      </form>
    </main>
  );
}
