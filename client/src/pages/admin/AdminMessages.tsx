import { toast } from "sonner";
import { Archive, Mail, MailCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, StatusBadge } from "./adminShared";

export default function AdminMessages() {
  const utils = trpc.useUtils();
  const messages = trpc.admin.messages.useQuery();
  const update = trpc.admin.updateMessageStatus.useMutation({
    onSuccess: () => utils.admin.messages.invalidate(),
    onError: () => toast.error("Failed to update message"),
  });

  return (
    <div>
      <PageHeader title="Messages" subtitle="Contact form submissions from the website" />
      {messages.isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
      ) : (messages.data ?? []).length === 0 ? (
        <div className="rounded-2xl bg-card p-10 text-center text-sm text-muted-foreground shadow-sm ring-1 ring-border">
          No messages yet. Contact form submissions will appear here.
        </div>
      ) : (
        <div className="space-y-4">
          {(messages.data ?? []).map(m => (
            <div key={m.id} className="rounded-2xl bg-card p-6 shadow-sm ring-1 ring-border">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-foreground">{m.name}</p>
                    <StatusBadge status={m.status} />
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold uppercase text-muted-foreground">
                      {m.locale}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {m.email}
                    {m.phone ? ` · ${m.phone}` : ""}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(m.createdAt).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              {m.subject && <p className="mt-3 text-sm font-medium text-foreground">{m.subject}</p>}
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{m.message}</p>
              <div className="mt-4 flex gap-2 border-t border-border pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg"
                  onClick={() => (window.location.href = `mailto:${m.email}`)}
                >
                  <Mail className="mr-1.5 h-3.5 w-3.5" /> Reply
                </Button>
                {m.status !== "replied" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-lg"
                    onClick={() => update.mutate({ id: m.id, status: "replied" })}
                  >
                    <MailCheck className="mr-1.5 h-3.5 w-3.5" /> Mark replied
                  </Button>
                )}
                {m.status !== "archived" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-lg text-muted-foreground"
                    onClick={() => update.mutate({ id: m.id, status: "archived" })}
                  >
                    <Archive className="mr-1.5 h-3.5 w-3.5" /> Archive
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

