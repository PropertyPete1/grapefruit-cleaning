import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { Archive, Edit3, FolderPlus, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

type CategoryForm = {
  id?: number;
  key: string;
  nameEn: string;
  nameEs: string;
  descriptionEn: string;
  descriptionEs: string;
  noteEn: string;
  noteEs: string;
  sortOrder: number;
  isEnabled: boolean;
  showPublicHeading: boolean;
};

type AddonForm = {
  id?: number;
  key: string;
  categoryId: number;
  nameEn: string;
  nameEs: string;
  descriptionEn: string;
  descriptionEs: string;
  includedItemsEn: string;
  includedItemsEs: string;
  noteEn: string;
  noteEs: string;
  priceMode: "fixed" | "starting_at" | "custom_quote";
  price: string;
  mayVary: boolean;
  sortOrder: number;
  isEnabled: boolean;
};

const EMPTY_CATEGORY: CategoryForm = {
  key: "",
  nameEn: "",
  nameEs: "",
  descriptionEn: "",
  descriptionEs: "",
  noteEn: "",
  noteEs: "",
  sortOrder: 0,
  isEnabled: true,
  showPublicHeading: true,
};

const EMPTY_ADDON: AddonForm = {
  key: "",
  categoryId: 0,
  nameEn: "",
  nameEs: "",
  descriptionEn: "",
  descriptionEs: "",
  includedItemsEn: "",
  includedItemsEs: "",
  noteEn: "",
  noteEs: "",
  priceMode: "fixed",
  price: "0.00",
  mayVary: false,
  sortOrder: 0,
  isEnabled: true,
};

function textList(value: string): string[] {
  return value.split("\n").map(item => item.trim()).filter(Boolean);
}

function optional(value: string): string | null {
  return value.trim() || null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>;
}

export function AddonCatalogManager() {
  const utils = trpc.useUtils();
  const catalog = trpc.admin.addonCatalog.catalog.useQuery();
  const [categoryForm, setCategoryForm] = useState<CategoryForm | null>(null);
  const [addonForm, setAddonForm] = useState<AddonForm | null>(null);

  const refresh = async () => {
    await Promise.all([utils.admin.addonCatalog.catalog.invalidate(), utils.booking.addonCatalog.invalidate()]);
  };
  const notify = (message: string) => { toast.success(message); void refresh(); };
  const fail = (error: { message: string }) => toast.error(error.message);

  const setRollout = trpc.admin.addonCatalog.setRolloutEnabled.useMutation({
    onSuccess: result => notify(result.enabled ? "Dynamic add-ons are live" : "Legacy add-ons restored"),
    onError: fail,
  });
  const createCategory = trpc.admin.addonCatalog.createCategory.useMutation({ onSuccess: () => { setCategoryForm(null); notify("Category created"); }, onError: fail });
  const updateCategory = trpc.admin.addonCatalog.updateCategory.useMutation({ onSuccess: () => { setCategoryForm(null); notify("Category saved"); }, onError: fail });
  const deleteCategory = trpc.admin.addonCatalog.deleteCategory.useMutation({ onSuccess: () => notify("Category removed"), onError: fail });
  const createAddon = trpc.admin.addonCatalog.createAddon.useMutation({ onSuccess: () => { setAddonForm(null); notify("Add-on created"); }, onError: fail });
  const updateAddon = trpc.admin.addonCatalog.updateAddon.useMutation({ onSuccess: () => { setAddonForm(null); notify("Add-on saved"); }, onError: fail });
  const removeAddon = trpc.admin.addonCatalog.removeAddon.useMutation({
    onSuccess: result => notify(result.mode === "archive" ? "Add-on archived; historical snapshots are preserved" : "Unused draft deleted"),
    onError: fail,
  });

  const categories = catalog.data?.categories ?? [];
  const categoryChoices = useMemo(() => categories.map(category => ({ id: category.id, label: category.nameEn })), [categories]);

  const submitCategory = () => {
    if (!categoryForm) return;
    const payload = {
      nameEn: categoryForm.nameEn,
      nameEs: categoryForm.nameEs,
      descriptionEn: optional(categoryForm.descriptionEn),
      descriptionEs: optional(categoryForm.descriptionEs),
      noteEn: optional(categoryForm.noteEn),
      noteEs: optional(categoryForm.noteEs),
      sortOrder: categoryForm.sortOrder,
      isEnabled: categoryForm.isEnabled,
      showPublicHeading: categoryForm.showPublicHeading,
    };
    if (categoryForm.id) updateCategory.mutate({ id: categoryForm.id, ...payload });
    else createCategory.mutate({ key: categoryForm.key, ...payload });
  };

  const submitAddon = () => {
    if (!addonForm) return;
    const startingPriceCents = Math.round(Number(addonForm.price) * 100);
    if (!Number.isInteger(startingPriceCents) || startingPriceCents < 1) {
      toast.error("Enter a starting price greater than $0.00");
      return;
    }
    const payload = {
      categoryId: addonForm.categoryId,
      nameEn: addonForm.nameEn,
      nameEs: addonForm.nameEs,
      descriptionEn: optional(addonForm.descriptionEn),
      descriptionEs: optional(addonForm.descriptionEs),
      includedItemsEn: textList(addonForm.includedItemsEn),
      includedItemsEs: textList(addonForm.includedItemsEs),
      noteEn: optional(addonForm.noteEn),
      noteEs: optional(addonForm.noteEs),
      priceMode: addonForm.priceMode,
      startingPriceCents,
      mayVary: addonForm.mayVary,
      sortOrder: addonForm.sortOrder,
      isEnabled: addonForm.isEnabled,
    };
    if (addonForm.id) updateAddon.mutate({ id: addonForm.id, ...payload });
    else createAddon.mutate({ key: addonForm.key, ...payload });
  };

  const openCategory = (category?: (typeof categories)[number]) => setCategoryForm(category ? {
    id: category.id,
    key: category.key,
    nameEn: category.nameEn,
    nameEs: category.nameEs,
    descriptionEn: category.descriptionEn ?? "",
    descriptionEs: category.descriptionEs ?? "",
    noteEn: category.noteEn ?? "",
    noteEs: category.noteEs ?? "",
    sortOrder: category.sortOrder,
    isEnabled: category.isEnabled,
    showPublicHeading: category.showPublicHeading,
  } : { ...EMPTY_CATEGORY });

  const openAddon = (categoryId: number, addon?: (typeof categories)[number]["addons"][number]) => setAddonForm(addon ? {
    id: addon.id,
    key: addon.key,
    categoryId: addon.categoryId ?? categoryId,
    nameEn: addon.nameEn,
    nameEs: addon.nameEs,
    descriptionEn: addon.descriptionEn ?? "",
    descriptionEs: addon.descriptionEs ?? "",
    includedItemsEn: addon.includedItemsEn.join("\n"),
    includedItemsEs: addon.includedItemsEs.join("\n"),
    noteEn: addon.noteEn ?? "",
    noteEs: addon.noteEs ?? "",
    priceMode: addon.priceMode,
    price: (addon.startingPriceCents / 100).toFixed(2),
    mayVary: addon.mayVary,
    sortOrder: addon.sortOrder,
    isEnabled: addon.isEnabled,
  } : { ...EMPTY_ADDON, categoryId });

  return (
    <section className="space-y-5 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-border sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2"><h2 className="text-lg font-semibold">Dynamic add-on catalog</h2><Badge variant={catalog.data?.enabled ? "default" : "secondary"}>{catalog.data?.enabled ? "Live" : "Legacy mode"}</Badge></div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Manage customer-facing categories, bilingual copy, prices, and availability. Historical booking and invoice snapshots do not change.</p>
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2">
          <Switch checked={catalog.data?.enabled ?? false} disabled={setRollout.isPending} onCheckedChange={checked => setRollout.mutate({ enabled: checked })} aria-label="Enable dynamic add-ons" />
          <span className="text-sm font-medium">Use catalog on public pages</span>
        </div>
      </div>

      <div className="flex justify-end"><Button variant="outline" onClick={() => openCategory()}><FolderPlus className="mr-2 size-4" />Add category</Button></div>

      <div className="space-y-4">
        {categories.map(category => (
          <div key={category.id} className="overflow-hidden rounded-xl border">
            <div className="flex flex-col gap-3 bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{category.nameEn}</h3><span className="text-sm text-muted-foreground">/ {category.nameEs}</span>{!category.isEnabled && <Badge variant="secondary">Disabled</Badge>}</div><p className="text-xs text-muted-foreground">{category.key} · order {category.sortOrder}</p></div>
              <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => openAddon(category.id)}><Plus className="mr-1 size-4" />Add option</Button><Button size="sm" variant="outline" onClick={() => openCategory(category)}><Edit3 className="mr-1 size-4" />Edit</Button><Button size="sm" variant="ghost" disabled={category.addons.length > 0} onClick={() => { if (confirm("Delete this empty category?")) deleteCategory.mutate({ id: category.id }); }}><Trash2 className="size-4" /></Button></div>
            </div>
            <div className="divide-y">
              {category.addons.map(addon => (
                <div key={addon.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{addon.nameEn}</span><span className="text-sm text-muted-foreground">/ {addon.nameEs}</span>{addon.priceMode !== "fixed" && <Badge variant="outline">{addon.priceMode.replace("_", " ")}</Badge>}{addon.mayVary && <Badge variant="secondary">may vary</Badge>}{(!addon.isEnabled || addon.archivedAt) && <Badge variant="secondary">Archived</Badge>}</div><p className="text-sm text-muted-foreground">${(addon.startingPriceCents / 100).toFixed(2)} · {addon.key} · order {addon.sortOrder}</p></div>
                  <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => openAddon(category.id, addon)}><Edit3 className="mr-1 size-4" />Edit</Button><Button size="sm" variant="ghost" onClick={() => { if (confirm("Remove this add-on? Referenced and seeded options are safely archived.")) removeAddon.mutate({ id: addon.id }); }}><Archive className="size-4" /></Button></div>
                </div>
              ))}
              {category.addons.length === 0 && <p className="p-4 text-sm text-muted-foreground">No options in this category.</p>}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={!!categoryForm} onOpenChange={open => !open && setCategoryForm(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{categoryForm?.id ? "Edit category" : "Add category"}</DialogTitle></DialogHeader>{categoryForm && <div className="grid gap-4 sm:grid-cols-2">
          {!categoryForm.id && <Field label="Stable key"><Input value={categoryForm.key} onChange={event => setCategoryForm({ ...categoryForm, key: event.target.value })} placeholder="steam-cleaning" /></Field>}
          <Field label="Sort order"><Input type="number" value={categoryForm.sortOrder} onChange={event => setCategoryForm({ ...categoryForm, sortOrder: Number(event.target.value) })} /></Field>
          <Field label="English name"><Input value={categoryForm.nameEn} onChange={event => setCategoryForm({ ...categoryForm, nameEn: event.target.value })} /></Field>
          <Field label="Spanish name"><Input value={categoryForm.nameEs} onChange={event => setCategoryForm({ ...categoryForm, nameEs: event.target.value })} /></Field>
          <Field label="English description"><Textarea value={categoryForm.descriptionEn} onChange={event => setCategoryForm({ ...categoryForm, descriptionEn: event.target.value })} /></Field>
          <Field label="Spanish description"><Textarea value={categoryForm.descriptionEs} onChange={event => setCategoryForm({ ...categoryForm, descriptionEs: event.target.value })} /></Field>
          <Field label="English note"><Textarea value={categoryForm.noteEn} onChange={event => setCategoryForm({ ...categoryForm, noteEn: event.target.value })} /></Field>
          <Field label="Spanish note"><Textarea value={categoryForm.noteEs} onChange={event => setCategoryForm({ ...categoryForm, noteEs: event.target.value })} /></Field>
          <div className="flex items-center gap-3"><Switch checked={categoryForm.isEnabled} onCheckedChange={isEnabled => setCategoryForm({ ...categoryForm, isEnabled })} /><Label>Enabled</Label></div>
          <div className="flex items-center gap-3"><Switch checked={categoryForm.showPublicHeading} onCheckedChange={showPublicHeading => setCategoryForm({ ...categoryForm, showPublicHeading })} /><Label>Show public heading</Label></div>
        </div>}<DialogFooter><Button variant="outline" onClick={() => setCategoryForm(null)}>Cancel</Button><Button onClick={submitCategory} disabled={createCategory.isPending || updateCategory.isPending}>Save category</Button></DialogFooter></DialogContent>
      </Dialog>

      <Dialog open={!!addonForm} onOpenChange={open => !open && setAddonForm(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{addonForm?.id ? "Edit add-on" : "Add add-on"}</DialogTitle></DialogHeader>{addonForm && <div className="grid gap-4 sm:grid-cols-2">
          {!addonForm.id && <Field label="Stable key"><Input value={addonForm.key} onChange={event => setAddonForm({ ...addonForm, key: event.target.value })} placeholder="new-upgrade" /></Field>}
          <Field label="Category"><Select value={String(addonForm.categoryId || "")} onValueChange={value => setAddonForm({ ...addonForm, categoryId: Number(value) })}><SelectTrigger><SelectValue placeholder="Choose category" /></SelectTrigger><SelectContent>{categoryChoices.map(category => <SelectItem key={category.id} value={String(category.id)}>{category.label}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="English name"><Input value={addonForm.nameEn} onChange={event => setAddonForm({ ...addonForm, nameEn: event.target.value })} /></Field>
          <Field label="Spanish name"><Input value={addonForm.nameEs} onChange={event => setAddonForm({ ...addonForm, nameEs: event.target.value })} /></Field>
          <Field label="English description"><Textarea value={addonForm.descriptionEn} onChange={event => setAddonForm({ ...addonForm, descriptionEn: event.target.value })} /></Field>
          <Field label="Spanish description"><Textarea value={addonForm.descriptionEs} onChange={event => setAddonForm({ ...addonForm, descriptionEs: event.target.value })} /></Field>
          <Field label="Included items — English (one per line)"><Textarea value={addonForm.includedItemsEn} onChange={event => setAddonForm({ ...addonForm, includedItemsEn: event.target.value })} /></Field>
          <Field label="Included items — Spanish (one per line)"><Textarea value={addonForm.includedItemsEs} onChange={event => setAddonForm({ ...addonForm, includedItemsEs: event.target.value })} /></Field>
          <Field label="English note"><Textarea value={addonForm.noteEn} onChange={event => setAddonForm({ ...addonForm, noteEn: event.target.value })} /></Field>
          <Field label="Spanish note"><Textarea value={addonForm.noteEs} onChange={event => setAddonForm({ ...addonForm, noteEs: event.target.value })} /></Field>
          <Field label="Price mode"><Select value={addonForm.priceMode} onValueChange={(priceMode: AddonForm["priceMode"]) => setAddonForm({ ...addonForm, priceMode, mayVary: priceMode === "fixed" ? addonForm.mayVary : true })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="fixed">Fixed</SelectItem><SelectItem value="starting_at">Starting at</SelectItem><SelectItem value="custom_quote">Custom quote</SelectItem></SelectContent></Select></Field>
          <Field label="Deposit-eligible starting price"><Input inputMode="decimal" value={addonForm.price} onChange={event => setAddonForm({ ...addonForm, price: event.target.value })} /></Field>
          <Field label="Sort order"><Input type="number" value={addonForm.sortOrder} onChange={event => setAddonForm({ ...addonForm, sortOrder: Number(event.target.value) })} /></Field>
          <div className="flex items-center gap-3"><Switch checked={addonForm.mayVary} onCheckedChange={mayVary => setAddonForm({ ...addonForm, mayVary })} /><Label>Price may vary</Label></div>
          <div className="flex items-center gap-3"><Switch checked={addonForm.isEnabled} onCheckedChange={isEnabled => setAddonForm({ ...addonForm, isEnabled })} /><Label>Enabled</Label></div>
        </div>}<DialogFooter><Button variant="outline" onClick={() => setAddonForm(null)}>Cancel</Button><Button onClick={submitAddon} disabled={createAddon.isPending || updateAddon.isPending}>Save add-on</Button></DialogFooter></DialogContent>
      </Dialog>
    </section>
  );
}
