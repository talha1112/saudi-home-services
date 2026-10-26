"use client";

import { api, describeError } from "@/lib/api";
import { sarH } from "@/lib/format";
import { ReasonDialog } from "./ReasonDialog";

export interface RefundTarget {
  paymentId: string;
  reference: string;
  /** Halalas still refundable: captured minus what refund requests already reserve. */
  available: number;
}

/** Requests a refund of everything still refundable on an online payment. Nothing is returned until a payment provider confirms it. */
export function RefundDialog({ target, onClose, onDone }: { target: RefundTarget; onClose: () => void; onDone: () => void }) {
  return (
    <ReasonDialog
      title={`Request refund · ${target.reference}`}
      subtitle={`Requests a refund of ${sarH(target.available)}, the whole amount still refundable. No money is returned until the payment provider confirms it.`}
      cta="Request refund"
      required
      hint="A reason is required and is kept with the request."
      onClose={onClose}
      onConfirm={async (reason) => {
        try {
          await api.post(`payments/${target.paymentId}/refunds`, { amountHalalas: target.available, reason }, { "Idempotency-Key": crypto.randomUUID() });
          onDone();
        } catch (e) {
          throw new Error(describeError(e));
        }
      }}
    />
  );
}

/** Finds the online payment of a booking and what is still refundable on it; throws a readable message when there is nothing to refund. */
export async function findRefundTarget(reference: string): Promise<RefundTarget> {
  const r = await api.get<{ items: { reference: string; payment: { id: string; capturedHalalas: number | null; refundReservedHalalas: number } | null }[] }>(`transactions?q=${encodeURIComponent(reference)}&limit=5`);
  const row = r.items.find((x) => x.reference === reference && x.payment);
  if (!row?.payment) throw new Error("Nothing to refund online: this booking was not paid online");
  const available = (row.payment.capturedHalalas ?? 0) - row.payment.refundReservedHalalas;
  if (available <= 0) throw new Error("The whole payment already has a refund requested");
  return { paymentId: row.payment.id, reference, available };
}
