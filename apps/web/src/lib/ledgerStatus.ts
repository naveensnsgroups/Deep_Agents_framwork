import { CheckCircle2, FileCheck, Circle, XCircle, MinusCircle, type LucideIcon } from "lucide-react";

/** Shared between LedgerPanel and FileTree so a file's status badge always matches its
 * row in the ledger panel — one source of truth for the icon/color per status. */
export const LEDGER_STATUS_ORDER = ["failed", "pending", "converted", "verified", "skipped"] as const;

export const LEDGER_STATUS_META: Record<string, { icon: LucideIcon; className: string; label: string }> = {
  verified: { icon: CheckCircle2, className: "text-green-400 light:text-green-600", label: "verified" },
  converted: { icon: FileCheck, className: "text-blue-300 light:text-blue-800", label: "converted" },
  pending: { icon: Circle, className: "text-neutral-400 light:text-neutral-600", label: "pending" },
  failed: { icon: XCircle, className: "text-red-400 light:text-red-600", label: "failed" },
  skipped: { icon: MinusCircle, className: "text-neutral-500", label: "skipped" },
};

export function ledgerStatusMeta(status: string) {
  return LEDGER_STATUS_META[status] ?? { icon: Circle, className: "text-neutral-400 light:text-neutral-600", label: status };
}
