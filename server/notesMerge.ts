/**
 * Merging customer-entered access notes into a booking's notes column.
 *
 * The owner's notes were written first, by hand, and may say things the
 * customer must never see ("haggler, quoted high", "gate code in CRM"). The
 * customer's notes arrive later, through the deposit link, and may be revised
 * on every re-mint. So the column holds both, separated by a labeled marker:
 * the admin part is everything before it, the customer part everything after,
 * and re-submitting replaces only the customer part.
 *
 * One column rather than two because notes flow everywhere — crew job cards,
 * the owner notification, the admin table — and every one of those reads
 * booking.notes. A second column would mean teaching each consumer to
 * concatenate, and the first one anyone forgets shows a crew half the story.
 */

/**
 * The label that opens the customer section. Recognized at the start of a
 * line, so an owner note that merely mentions these words mid-sentence is
 * never mistaken for the boundary.
 */
export const CUSTOMER_NOTES_LABEL = "From customer:";

/** The admin-written part of a notes column: everything before the label. */
export function adminNotesOf(notes: string | null | undefined): string {
  if (!notes) return "";
  const at = boundaryIndex(notes);
  return (at === -1 ? notes : notes.slice(0, at)).trimEnd();
}

/** The customer-written part, without the label. Empty when there is none. */
export function customerNotesOf(notes: string | null | undefined): string {
  if (!notes) return "";
  const at = boundaryIndex(notes);
  if (at === -1) return "";
  return notes.slice(at + CUSTOMER_NOTES_LABEL.length + labelOffset(notes, at)).trim();
}

/**
 * The notes column after the customer (re-)submits their text.
 *
 * The admin part survives verbatim; the previous customer section, if any, is
 * replaced rather than stacked — a customer re-minting three times with edits
 * must not leave three copies. An empty submission removes the section: they
 * typed, thought better of it, and cleared the field.
 */
export function mergeCustomerNotes(existing: string | null | undefined, customerText: string): string {
  const admin = adminNotesOf(existing);
  const customer = customerText.trim();
  if (!customer) return admin;
  if (!admin) return `${CUSTOMER_NOTES_LABEL} ${customer}`;
  return `${admin}\n\n${CUSTOMER_NOTES_LABEL} ${customer}`;
}

/** Index of the boundary label at the start of a line, or -1. */
function boundaryIndex(notes: string): number {
  if (notes.startsWith(CUSTOMER_NOTES_LABEL)) return 0;
  const at = notes.indexOf(`\n${CUSTOMER_NOTES_LABEL}`);
  return at === -1 ? -1 : at + 1;
}

/** Length of the whitespace between the label and the text ("" or " "). */
function labelOffset(notes: string, at: number): number {
  return notes[at + CUSTOMER_NOTES_LABEL.length] === " " ? 1 : 0;
}
