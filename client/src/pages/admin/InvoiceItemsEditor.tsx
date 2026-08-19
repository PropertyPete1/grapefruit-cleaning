/**
 * The itemization editor shared by both places an invoice is priced: the
 * balance approval dialog and the manual "Create invoice" dialog.
 *
 * Extracted rather than copied, deliberately. Both screens must offer the same
 * add-ons at the same live catalog prices and enforce the same rules on custom
 * lines, because both feed the identical server resolver and the identical
 * stored snapshot. A second copy of this UI would be a second set of rules to
 * keep in sync, and the first thing to drift would be validation.
 *
 * State lives with the parent: each dialog owns its own reset/submit lifecycle,
 * and this component only renders and reports.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CUSTOM_ITEM_MAX } from "@shared/invoiceItems";
import { EXTRA_IDS, type ExtraId } from "@shared/pricing";
import { en } from "@/i18n/translations/en";
import { fmtMoney } from "./adminShared";

export type CustomItemRow = { name: string; amount: string };

/** A custom row parsed for submission and validation. */
export type ParsedCustomItem = { name: string; amount: number };

/** The one definition of a valid custom line, mirroring the server's Zod rules. */
export function parseCustomItems(rows: CustomItemRow[]): ParsedCustomItem[] {
  return rows.map(row => ({ name: row.name.trim(), amount: Number(row.amount) }));
}

export function customItemsValid(parsed: ParsedCustomItem[]): boolean {
  return parsed.every(
    row => row.name.length > 0 && Number.isInteger(row.amount) && row.amount >= 1 && row.amount <= CUSTOM_ITEM_MAX
  );
}

/** Add-on price as billed: whole dollars, never below $1 — matches the server. */
export function addonPrice(extras: Record<string, number>, id: ExtraId): number {
  return Math.max(1, Math.round(extras[id] ?? 0));
}

export function addonsTotal(extras: Record<string, number>, ids: ExtraId[]): number {
  return ids.reduce((sum, id) => sum + addonPrice(extras, id), 0);
}

export function InvoiceItemsEditor({
  extras,
  checkedAddons,
  onToggleAddon,
  customs,
  onCustomsChange,
  addonsLabel = "Add-ons done on-site",
  addonsHint = "Checked items appear on the invoice by name, priced from today's catalog.",
}: {
  extras: Record<string, number>;
  checkedAddons: ExtraId[];
  onToggleAddon: (id: ExtraId) => void;
  customs: CustomItemRow[];
  onCustomsChange: (next: CustomItemRow[]) => void;
  addonsLabel?: string;
  addonsHint?: string;
}) {
  const parsed = parseCustomItems(customs);
  const valid = customItemsValid(parsed);

  return (
    <>
      <div>
        <Label>{addonsLabel}</Label>
        <p className="mt-0.5 text-xs text-muted-foreground">{addonsHint}</p>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {EXTRA_IDS.map(id => {
            const active = checkedAddons.includes(id);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => onToggleAddon(id)}
                className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                  active
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border bg-card text-muted-foreground hover:border-primary/40"
                }`}
              >
                <span className="min-w-0 truncate">{(en.extras as Record<string, string>)[id] ?? id}</span>
                <span className="shrink-0">+{fmtMoney(addonPrice(extras, id))}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <Label>One-off charges</Label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Anything not in the catalog. Every line needs a name — the customer sees exactly these words.
        </p>
        {customs.map((row, index) => (
          <div key={index} className="mt-2 flex gap-2">
            <Input
              className="flex-1 rounded-xl"
              placeholder="e.g. Carpet spot treatment"
              value={row.name}
              onChange={e => onCustomsChange(customs.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))}
            />
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={CUSTOM_ITEM_MAX}
              className="w-24 rounded-xl"
              placeholder="$"
              value={row.amount}
              onChange={e =>
                onCustomsChange(customs.map((r, i) => (i === index ? { ...r, amount: e.target.value } : r)))
              }
            />
            <Button
              type="button"
              variant="outline"
              className="rounded-xl px-2.5"
              onClick={() => onCustomsChange(customs.filter((_, i) => i !== index))}
              aria-label="Remove line"
            >
              ×
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 rounded-lg text-xs"
          onClick={() => onCustomsChange([...customs, { name: "", amount: "" }])}
        >
          + Add a line
        </Button>
        {!valid && (
          <p className="mt-1.5 text-xs text-destructive">
            Every line needs a name and a whole-dollar amount of $1 or more.
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The running total, itemized: base service then each named charge. Previews
 * exactly the arithmetic the server performs, so the number on the button is
 * the number that gets billed.
 */
export function InvoiceItemsSummary({
  extras,
  base,
  checkedAddons,
  customs,
  total,
  totalLabel = "Invoice total",
}: {
  extras: Record<string, number>;
  base: number;
  checkedAddons: ExtraId[];
  customs: ParsedCustomItem[];
  total: number;
  totalLabel?: string;
}) {
  if (checkedAddons.length === 0 && customs.length === 0) return null;
  return (
    <dl className="space-y-1 rounded-xl bg-muted/50 p-3 text-xs">
      <div className="flex justify-between">
        <dt className="text-muted-foreground">Service</dt>
        <dd className="font-medium">{fmtMoney(base)}</dd>
      </div>
      {checkedAddons.map(id => (
        <div key={id} className="flex justify-between">
          <dt className="text-muted-foreground">{(en.extras as Record<string, string>)[id] ?? id}</dt>
          <dd className="font-medium">{fmtMoney(addonPrice(extras, id))}</dd>
        </div>
      ))}
      {customs.map(
        (row, index) =>
          row.name && (
            <div key={index} className="flex justify-between">
              <dt className="text-muted-foreground">{row.name}</dt>
              <dd className="font-medium">{Number.isFinite(row.amount) ? fmtMoney(row.amount) : "—"}</dd>
            </div>
          )
      )}
      <div className="flex justify-between border-t border-border pt-1">
        <dt className="font-semibold text-foreground">{totalLabel}</dt>
        <dd className="font-semibold text-foreground">{fmtMoney(total)}</dd>
      </div>
    </dl>
  );
}
