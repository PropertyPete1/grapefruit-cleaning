/**
 * The opened view of an Admin → Invoices row: property, service and customer
 * for an invoice with a booking behind it, or a plain statement that there is
 * none (a manual invoice) followed by the customer on file.
 *
 * One component for both layouts. It renders inside RowCard's note slot on
 * phones and in a full-width row under the invoice on the desktop table, where
 * the sections sit side by side.
 */
import { NotesBlock } from "./adminShared";
import { describeInvoiceContext, type ContextRow, type InvoiceContextInput } from "./invoiceContext";

function Section({ title, rows }: { title: string; rows: ContextRow[] }) {
  return (
    <section className="rounded-xl bg-muted/50 p-3 text-xs">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <dl className="space-y-1.5">
        {rows.map(row => (
          <div key={row.label} className="flex justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 break-words text-right font-medium text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function InvoiceContextPanel({ invoice }: { invoice: InvoiceContextInput }) {
  const view = describeInvoiceContext(invoice);

  if (view.kind === "no_booking") {
    const warning = view.tone === "warning";
    return (
      <div className="grid gap-2 lg:grid-cols-3">
        <div
          className={`rounded-xl p-3 text-xs ring-1 lg:col-span-2 ${
            warning ? "bg-amber-50 ring-amber-200" : "bg-muted/50 ring-border"
          }`}
        >
          <p className={`font-semibold ${warning ? "text-amber-900" : "text-foreground"}`}>{view.heading}</p>
          <p className={`mt-0.5 ${warning ? "text-amber-800" : "text-muted-foreground"}`}>{view.explanation}</p>
        </div>
        {view.property && <Section title="Property" rows={view.property} />}
        <Section title="Customer on file" rows={view.customer} />
        {view.payment.length > 0 && <Section title="Payment" rows={view.payment} />}
      </div>
    );
  }

  return (
    <div className="grid gap-2 lg:grid-cols-4">
      <Section title="Property" rows={view.property} />
      <Section title="Service" rows={view.service} />
      <Section title="Customer" rows={view.customer} />
      {view.payment.length > 0 && <Section title="Payment" rows={view.payment} />}
      {view.notes && <NotesBlock notes={view.notes} className="lg:col-span-4" />}
    </div>
  );
}
