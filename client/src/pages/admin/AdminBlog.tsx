import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "./adminShared";

type PostForm = {
  id?: number;
  slug: string;
  titleEn: string;
  titleEs: string;
  excerptEn: string;
  excerptEs: string;
  bodyEn: string;
  bodyEs: string;
  coverImage: string;
  readTime: number;
  published: boolean;
  publishedAt: string;
};

const EMPTY: PostForm = {
  slug: "",
  titleEn: "",
  titleEs: "",
  excerptEn: "",
  excerptEs: "",
  bodyEn: "",
  bodyEs: "",
  coverImage: "",
  readTime: 5,
  published: false,
  publishedAt: new Date().toISOString().slice(0, 10),
};

function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

export default function AdminBlog() {
  const utils = trpc.useUtils();
  const posts = trpc.admin.blogPosts.useQuery();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PostForm>(EMPTY);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const isEdit = form.id !== undefined;

  const invalidate = () => {
    utils.admin.blogPosts.invalidate();
    utils.content.blogPosts.invalidate();
    utils.content.blogPost.invalidate();
  };

  const create = trpc.admin.createBlogPost.useMutation({
    onSuccess: () => {
      invalidate();
      setOpen(false);
      toast.success("Post created");
    },
    onError: (e) => toast.error(e.message || "Failed to create post"),
  });
  const update = trpc.admin.updateBlogPost.useMutation({
    onSuccess: () => {
      invalidate();
      setOpen(false);
      toast.success("Post updated");
    },
    onError: (e) => toast.error(e.message || "Failed to update post"),
  });
  const togglePublish = trpc.admin.updateBlogPost.useMutation({
    onSuccess: () => invalidate(),
    onError: () => toast.error("Failed to update"),
  });
  const remove = trpc.admin.deleteBlogPost.useMutation({
    onSuccess: () => {
      invalidate();
      setDeleteId(null);
      toast.success("Post deleted");
    },
    onError: () => toast.error("Failed to delete"),
  });

  const openCreate = () => {
    setForm({ ...EMPTY, publishedAt: new Date().toISOString().slice(0, 10) });
    setOpen(true);
  };
  const openEdit = (p: NonNullable<typeof posts.data>[number]) => {
    setForm({
      id: p.id,
      slug: p.slug,
      titleEn: p.titleEn,
      titleEs: p.titleEs,
      excerptEn: p.excerptEn ?? "",
      excerptEs: p.excerptEs ?? "",
      bodyEn: p.bodyEn,
      bodyEs: p.bodyEs,
      coverImage: p.coverImage ?? "",
      readTime: p.readTime,
      published: p.published,
      publishedAt: p.publishedAt ?? new Date().toISOString().slice(0, 10),
    });
    setOpen(true);
  };

  const submit = () => {
    if (!form.titleEn.trim() || !form.titleEs.trim()) return toast.error("Both titles are required");
    if (!form.bodyEn.trim() || !form.bodyEs.trim()) return toast.error("Both article bodies are required");
    const slug = form.slug.trim() || slugify(form.titleEn);
    if (slug.length < 3) return toast.error("Slug must be at least 3 characters");
    const payload = {
      slug,
      titleEn: form.titleEn.trim(),
      titleEs: form.titleEs.trim(),
      excerptEn: form.excerptEn.trim() || undefined,
      excerptEs: form.excerptEs.trim() || undefined,
      bodyEn: form.bodyEn,
      bodyEs: form.bodyEs,
      coverImage: form.coverImage.trim() || undefined,
      readTime: form.readTime,
      published: form.published,
      publishedAt: form.publishedAt || undefined,
    };
    if (isEdit) update.mutate({ id: form.id!, ...payload });
    else create.mutate(payload);
  };

  return (
    <div>
      <PageHeader
        title="Blog"
        subtitle="Write and manage articles shown on the public blog (English + Spanish)"
        action={
          <Button onClick={openCreate} className="rounded-full">
            <Plus className="mr-1.5 h-4 w-4" />
            New post
          </Button>
        }
      />

      {posts.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-2xl" />
          ))}
        </div>
      ) : !posts.data || posts.data.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          No blog posts yet. Click "New post" to write your first article.
        </div>
      ) : (
        <div className="space-y-3">
          {posts.data.map((p) => (
            <div
              key={p.id}
              className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-soft sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-center gap-4">
                {p.coverImage ? (
                  <img src={p.coverImage} alt="" className="hidden h-14 w-20 rounded-xl object-cover sm:block" />
                ) : null}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-semibold text-foreground">{p.titleEn}</p>
                    {p.published ? (
                      <Badge className="bg-primary/15 text-primary hover:bg-primary/15">Published</Badge>
                    ) : (
                      <Badge variant="secondary">Draft</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    /blog/{p.slug} · {p.publishedAt ?? "no date"} · {p.readTime} min read
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={p.published}
                    onCheckedChange={(v) => togglePublish.mutate({ id: p.id, published: v })}
                  />
                  <span className="text-xs text-muted-foreground">{p.published ? "Live" : "Hidden"}</span>
                </div>
                <Button variant="outline" size="sm" className="rounded-full" onClick={() => openEdit(p)}>
                  <Pencil className="mr-1 h-3.5 w-3.5" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteId(p.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit post" : "New post"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Tabs defaultValue="en">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="en">English</TabsTrigger>
                <TabsTrigger value="es">Español</TabsTrigger>
              </TabsList>
              <TabsContent value="en" className="space-y-3 pt-2">
                <div className="space-y-1.5">
                  <Label>Title (EN)</Label>
                  <Input
                    value={form.titleEn}
                    onChange={(e) => setForm((f) => ({ ...f, titleEn: e.target.value }))}
                    placeholder="e.g. 5 Habits of a Spotless Kitchen"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Excerpt (EN)</Label>
                  <Textarea
                    value={form.excerptEn}
                    onChange={(e) => setForm((f) => ({ ...f, excerptEn: e.target.value }))}
                    rows={2}
                    placeholder="Short summary shown on the blog list"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Body (EN)</Label>
                  <Textarea
                    value={form.bodyEn}
                    onChange={(e) => setForm((f) => ({ ...f, bodyEn: e.target.value }))}
                    rows={10}
                    placeholder="Write the article. Separate paragraphs with a blank line."
                  />
                </div>
              </TabsContent>
              <TabsContent value="es" className="space-y-3 pt-2">
                <div className="space-y-1.5">
                  <Label>Título (ES)</Label>
                  <Input
                    value={form.titleEs}
                    onChange={(e) => setForm((f) => ({ ...f, titleEs: e.target.value }))}
                    placeholder="p. ej. 5 Hábitos de una Cocina Impecable"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Resumen (ES)</Label>
                  <Textarea
                    value={form.excerptEs}
                    onChange={(e) => setForm((f) => ({ ...f, excerptEs: e.target.value }))}
                    rows={2}
                    placeholder="Resumen corto para la lista del blog"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Contenido (ES)</Label>
                  <Textarea
                    value={form.bodyEs}
                    onChange={(e) => setForm((f) => ({ ...f, bodyEs: e.target.value }))}
                    rows={10}
                    placeholder="Escriba el artículo. Separe los párrafos con una línea en blanco."
                  />
                </div>
              </TabsContent>
            </Tabs>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>URL slug</Label>
                <Input
                  value={form.slug}
                  onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                  placeholder={form.titleEn ? slugify(form.titleEn) : "auto-generated-from-title"}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Cover image URL (optional)</Label>
                <Input
                  value={form.coverImage}
                  onChange={(e) => setForm((f) => ({ ...f, coverImage: e.target.value }))}
                  placeholder="https://... or /manus-storage/..."
                />
              </div>
              <div className="space-y-1.5">
                <Label>Display date</Label>
                <Input
                  type="date"
                  value={form.publishedAt}
                  onChange={(e) => setForm((f) => ({ ...f, publishedAt: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Read time (minutes)</Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={form.readTime}
                  onChange={(e) => setForm((f) => ({ ...f, readTime: Math.max(1, Math.min(60, Number(e.target.value) || 5)) }))}
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">Published</p>
                <p className="text-xs text-muted-foreground">Visible on the public blog when enabled</p>
              </div>
              <Switch checked={form.published} onCheckedChange={(v) => setForm((f) => ({ ...f, published: v }))} />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" className="rounded-full" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                className="rounded-full"
                onClick={submit}
                disabled={create.isPending || update.isPending}
              >
                {isEdit ? "Save changes" : "Create post"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteId !== null} onOpenChange={(v) => !v && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this post?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the article from the blog. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId !== null && remove.mutate({ id: deleteId })}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
