import { Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "./adminShared";

export default function AdminReviews() {
  const utils = trpc.useUtils();
  const reviews = trpc.admin.reviews.useQuery();
  const update = trpc.admin.updateReview.useMutation({
    onSuccess: () => {
      utils.admin.reviews.invalidate();
      toast.success("Review updated");
    },
    onError: () => toast.error("Failed to update review"),
  });
  const remove = trpc.admin.deleteReview.useMutation({
    onSuccess: () => {
      utils.admin.reviews.invalidate();
      toast.success("Review deleted");
    },
    onError: () => toast.error("Failed to delete review"),
  });

  return (
    <div>
      <PageHeader
        title="Reviews"
        subtitle="Approve customer reviews before they appear on the public site"
      />
      {reviews.isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
      ) : (reviews.data ?? []).length === 0 ? (
        <div className="rounded-2xl bg-card p-10 text-center text-sm text-muted-foreground shadow-sm ring-1 ring-border">
          No reviews submitted yet. Reviews left by customers on the website will appear here for approval.
        </div>
      ) : (
        <div className="space-y-4">
          {(reviews.data ?? []).map(r => (
            <div key={r.id} className="rounded-2xl bg-card p-6 shadow-sm ring-1 ring-border">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-foreground">{r.customerName}</p>
                  <div className="mt-1 flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map(n => (
                      <Star
                        key={n}
                        className={`h-4 w-4 ${n <= r.rating ? "fill-amber-400 text-amber-400" : "text-border"}`}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    {r.approved ? "Visible" : "Hidden"}
                    <Switch checked={r.approved} onCheckedChange={v => update.mutate({ id: r.id, approved: v })} />
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => remove.mutate({ id: r.id })}
                    aria-label="Delete review"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{r.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
