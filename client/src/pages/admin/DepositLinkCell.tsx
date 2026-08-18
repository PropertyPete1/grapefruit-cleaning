/**
 * Deposit-link status for one admin-created booking, with the two things the
 * owner actually does with it: copy the link, or resend it.
 *
 * The URL is fetched on demand — one booking, when asked — rather than riding
 * along in the appointments list. The token behind it is a bearer credential:
 * anyone holding it can open that customer's pay page, so it stays out of the
 * payload that renders a table of forty bookings.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, Send } from "lucide-react";
import type { DepositLinkStatus } from "@shared/depositLinkStatus";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

const LABELS: Record<DepositLinkStatus, { text: string; className: string; title: string }> = {
  none: { text: "—", className: "text-muted-foreground", title: "Booked online — no deposit link was issued." },
  incomplete: {
    text: "Incomplete",
    className: "bg-sky-100 text-sky-800",
    title:
      "The customer still has choices to make on their link — service, size, or time. No slot is held until they pick one.",
  },
  awaiting_payment: {
    text: "Awaiting payment",
    className: "bg-amber-100 text-amber-800",
    title: "The customer has the link and hasn't paid yet. Their slot is held until the link expires.",
  },
  paid: {
    text: "Paid",
    className: "bg-emerald-100 text-emerald-800",
    title: "The deposit landed and the booking is confirmed.",
  },
  expired: {
    text: "Expired",
    className: "bg-red-100 text-red-700",
    title: "The hold ran out with the deposit unpaid — the slot has been released. Resend to issue a fresh link.",
  },
};

export function DepositLinkCell({ bookingId, status }: { bookingId: number; status: DepositLinkStatus }) {
  const utils = trpc.useUtils();
  const [wantLink, setWantLink] = useState(false);
  const label = LABELS[status];

  const link = trpc.admin.depositLink.useQuery({ id: bookingId }, { enabled: wantLink });

  const resend = trpc.admin.resendDepositLink.useMutation({
    onSuccess: async data => {
      utils.admin.bookings.invalidate();
      utils.admin.depositLink.invalidate({ id: bookingId });
      try {
        await navigator.clipboard.writeText(data.payUrl);
      } catch {
        /* the toast still tells them it went out */
      }
      toast.success(
        data.emailSent
          ? "Fresh link emailed — and copied to your clipboard"
          : "Fresh link created and copied — email didn't go out, so text it"
      );
    },
    onError: error => toast.error(error.message || "Failed to resend the link"),
  });

  if (status === "none") {
    return <span className="text-xs text-muted-foreground" title={label.title}>—</span>;
  }

  const copy = async () => {
    // Fetching and copying in one gesture: the owner wants the link on their
    // clipboard, not on their screen.
    const result = link.data ?? (await utils.admin.depositLink.fetch({ id: bookingId }));
    setWantLink(true);
    try {
      await navigator.clipboard.writeText(result.url);
      toast.success("Link copied — paste it into a text message");
    } catch {
      toast.error("Couldn't copy automatically — try again from a secure connection");
    }
  };

  return (
    <div className="space-y-1.5">
      <span
        className={`inline-block w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold ${label.className}`}
        title={label.title}
      >
        {label.text}
      </span>
      <div className="flex gap-1">
        {(status === "awaiting_payment" || status === "incomplete") && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-lg px-2 text-[11px]"
            onClick={copy}
            title="Copy the deposit link"
          >
            <Copy className="mr-1 h-3 w-3" /> Copy
          </Button>
        )}
        {(status === "awaiting_payment" || status === "incomplete" || status === "expired") && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-lg px-2 text-[11px]"
            disabled={resend.isPending}
            onClick={() => resend.mutate({ id: bookingId })}
            title="Issue a fresh link and email it — the old link stops working"
          >
            {resend.isPending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Send className="mr-1 h-3 w-3" />
            )}
            Resend
          </Button>
        )}
      </div>
    </div>
  );
}
