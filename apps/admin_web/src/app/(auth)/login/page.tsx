"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, describeError, sessionApi } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sessionApi.login(email.trim(), password, mfaCode.trim() || undefined);
      router.replace(result.mustChangePassword ? "/change-password" : "/dashboard");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && /MFA/i.test(err.code)) setNeedsCode(true);
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4">
      <form onSubmit={submit} className="flex w-full max-w-[400px] flex-col gap-4 rounded-2xl border border-line bg-white p-8 shadow-[0_18px_50px_rgba(23,43,53,.08)]">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate">Home Services</div>
          <h1 className="text-2xl font-bold">Admin sign-in</h1>
        </div>
        <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold">
          Email
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className="h-11 rounded-[11px] border-[1.5px] border-line px-3 text-sm font-normal" />
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold">
          Password
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-11 rounded-[11px] border-[1.5px] border-line px-3 text-sm font-normal" />
        </label>
        {needsCode && (
          <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold">
            Verification code
            <input inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} className="h-11 rounded-[11px] border-[1.5px] border-line px-3 text-sm font-normal" />
          </label>
        )}
        {error && (
          <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-3 py-2.5 text-[13px] text-danger">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy || !email || !password} className="h-11 rounded-xl bg-brand font-semibold text-white disabled:opacity-50">
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-xs text-slate">Forgot your password? An operator resets it with the server command <code>admin:reset-password</code>.</p>
      </form>
    </main>
  );
}
