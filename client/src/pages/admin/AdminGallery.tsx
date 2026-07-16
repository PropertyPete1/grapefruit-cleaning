import { useRef, useState } from "react";
import { ImageUp, Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "./adminShared";

const CATEGORIES = ["residential", "commercial", "airbnb", "deep"] as const;

export default function AdminGallery() {
  const utils = trpc.useUtils();
  const items = trpc.admin.gallery.useQuery();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ url: "", altEn: "", altEs: "", category: "residential" as (typeof CATEGORIES)[number] });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const create = trpc.admin.createGalleryItem.useMutation({
    onSuccess: () => {
      utils.admin.gallery.invalidate();
      setOpen(false);
      setForm({ url: "", altEn: "", altEs: "", category: "residential" });
      toast.success("Image added to gallery");
    },
    onError: () => toast.error("Failed to add image"),
  });
  const update = trpc.admin.updateGalleryItem.useMutation({
    onSuccess: () => utils.admin.gallery.invalidate(),
    onError: () => toast.error("Failed to update"),
  });
  const remove = trpc.admin.deleteGalleryItem.useMutation({
    onSuccess: () => {
      utils.admin.gallery.invalidate();
      toast.success("Image removed");
    },
    onError: () => toast.error("Failed to remove"),
  });
  const upload = trpc.admin.uploadGalleryImage.useMutation({
    onSuccess: ({ url }) => {
      setForm(f => ({ ...f, url }));
      toast.success("Image uploaded");
    },
    onError: e => toast.error(e.message || "Upload failed — try a smaller image"),
  });

  const handleFile = (file: File | undefined | null) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif|avif)$/i.test(file.type)) {
      toast.error("Please choose a PNG, JPEG, WebP, GIF, or AVIF image");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be 5MB or smaller");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.slice(result.indexOf(",") + 1);
      upload.mutate({ fileName: file.name, mimeType: file.type, dataBase64: base64 });
    };
    reader.onerror = () => toast.error("Could not read the file");
    reader.readAsDataURL(file);
  };

  return (
    <div>
      <PageHeader
        title="Gallery"
        subtitle="Manage the photos shown on the public gallery page"
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="rounded-xl">
                <Plus className="mr-1.5 h-4 w-4" /> Add image
              </Button>
            </DialogTrigger>
            <DialogContent className="rounded-2xl sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Add gallery image</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="g-url">Image</Label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Input
                      id="g-url"
                      placeholder="Upload a photo or paste a URL…"
                      className="rounded-xl"
                      value={form.url}
                      onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                    />
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                      className="hidden"
                      onChange={e => {
                        handleFile(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0 rounded-xl"
                      disabled={upload.isPending}
                      onClick={() => fileInputRef.current?.click()}
                      title="Upload image"
                    >
                      {upload.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ImageUp className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  {form.url ? (
                    <div className="relative mt-2 inline-block">
                      <img
                        src={form.url}
                        alt="Preview"
                        className="h-20 w-32 rounded-lg border object-cover"
                        onError={e => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                      <button
                        type="button"
                        className="absolute -right-2 -top-2 rounded-full bg-destructive p-0.5 text-destructive-foreground shadow"
                        onClick={() => setForm(f => ({ ...f, url: "" }))}
                        aria-label="Remove image"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : null}
                </div>
                <div>
                  <Label htmlFor="g-alt-en">Alt text (English)</Label>
                  <Input
                    id="g-alt-en"
                    className="mt-1.5 rounded-xl"
                    value={form.altEn}
                    onChange={e => setForm(f => ({ ...f, altEn: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="g-alt-es">Alt text (Spanish)</Label>
                  <Input
                    id="g-alt-es"
                    className="mt-1.5 rounded-xl"
                    value={form.altEs}
                    onChange={e => setForm(f => ({ ...f, altEs: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>Category</Label>
                  <Select
                    value={form.category}
                    onValueChange={v => setForm(f => ({ ...f, category: v as (typeof CATEGORIES)[number] }))}
                  >
                    <SelectTrigger className="mt-1.5 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map(c => (
                        <SelectItem key={c} value={c} className="capitalize">
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  className="w-full rounded-xl"
                  disabled={!form.url || create.isPending}
                  onClick={() => create.mutate(form)}
                >
                  {create.isPending ? "Adding…" : "Add image"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        }
      />

      {items.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-52 w-full rounded-2xl" />
          ))}
        </div>
      ) : (items.data ?? []).length === 0 ? (
        <div className="rounded-2xl bg-card p-10 text-center text-sm text-muted-foreground shadow-sm ring-1 ring-border">
          No custom gallery images yet. The public gallery currently shows the built-in portfolio set; images you
          add here are appended to it.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(items.data ?? []).map(item => (
            <div key={item.id} className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-border">
              <img src={item.url} alt={item.altEn ?? ""} className="h-44 w-full object-cover" />
              <div className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium capitalize text-foreground">{item.category}</p>
                  <p className="max-w-40 truncate text-xs text-muted-foreground">{item.altEn ?? "—"}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={item.visible}
                    onCheckedChange={v => update.mutate({ id: item.id, visible: v })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => remove.mutate({ id: item.id })}
                    aria-label="Delete image"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
