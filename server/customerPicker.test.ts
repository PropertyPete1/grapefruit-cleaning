/**
 * PR C2's admin conveniences and the tap-to-text link.
 *
 * What this file pins:
 *   - Admin → New booking can pick an existing customer: the booking lands on
 *     that record and the prefilled (and possibly corrected) contact fields
 *     refresh it; a customer typed in fresh is matched or created as before;
 *     the brain write API's "row id and nothing else" passthrough still skips
 *     the refresh;
 *   - Test G — the customer popout on Admin → Invoices edits the service type
 *     and date that name the bill, clears either, never touches the amount,
 *     and refuses an unknown invoice or a malformed date;
 *   - the tap-to-text line: two public settings keys, the sms: link built from
 *     whatever format the number was typed in, hidden when blank, and the
 *     review link stays admin-only;
 *   - the components read the right procedures and keep the phone layout rules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockGetSetting = vi.fn();
const mockCreateBooking = vi.fn();
const mockFindOrCreateCustomer = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockUpdateInvoice = vi.fn();
const mockListSettings = vi.fn();
const mockLookupProperty = vi.fn();
const mockSendMail = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    stripPayToken: actual.stripPayToken,
    isSlotTakenError: actual.isSlotTakenError,
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
    createBooking: (...a: unknown[]) => mockCreateBooking(...a),
    findOrCreateCustomer: (...a: unknown[]) => mockFindOrCreateCustomer(...a),
    getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
    getInvoiceById: (...a: unknown[]) => mockGetInvoiceById(...a),
    updateInvoice: (...a: unknown[]) => mockUpdateInvoice(...a),
    listSettings: (...a: unknown[]) => mockListSettings(...a),
    listGrandfatheredCustomers: vi.fn().mockResolvedValue([]),
    getOccupiedBookings: vi.fn().mockResolvedValue([]),
    updateBooking: vi.fn().mockResolvedValue(undefined),
    getBookingById: vi.fn().mockResolvedValue(undefined),
    getBookingByPayToken: vi.fn().mockResolvedValue(undefined),
    getCouponByCode: vi.fn().mockResolvedValue(undefined),
    listBookings: vi.fn().mockResolvedValue([]),
    expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
    listElapsedDepositBookings: vi.fn().mockResolvedValue([]),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
    listInvoices: vi.fn().mockResolvedValue([]),
    listInvoicesAwaitingApproval: vi.fn().mockResolvedValue([]),
    setSetting: vi.fn().mockResolvedValue(undefined),
    createReview: vi.fn(),
    listReviews: vi.fn().mockResolvedValue([]),
    listGalleryItems: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./property", () => ({
  lookupPropertySqft: (...a: unknown[]) => mockLookupProperty(...a),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: vi.fn(), expire: vi.fn() } } }),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { PUBLIC_SETTING_KEYS } from "@shared/const";
import { REVIEW_URL_SETTING_KEY, TEXT_NAME_SETTING_KEY, TEXT_NUMBER_SETTING_KEY, smsHref } from "@shared/reviewRequest";
import { _resetRateLimits } from "./antiSpam";
import { createAdminBooking } from "./adminBooking";
import { adminRouter } from "./routers/admin";
import { publicContentRouter } from "./routers/publicContent";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
const ORIGIN = "https://grapeclean.example";

const MARIA = {
  id: 41,
  firstName: "Maria del Mar",
  lastName: "Prado",
  email: "maria.prado@example.com",
  phone: "(210) 555-0199",
  address: "1200 Barton Springs Rd",
  city: "San Antonio",
  zip: "78205",
  preferredLocale: "es",
  grandfatheredPriceCents: null,
  grandfatheredServiceType: null,
};

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as never);

const written = () => mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
  mockCreateBooking.mockResolvedValue(99);
  mockFindOrCreateCustomer.mockImplementation(async (data: { customerId?: number }) => data.customerId ?? 7);
  mockGetCustomerById.mockImplementation(async (id: number) => (id === 41 ? MARIA : undefined));
  mockGetInvoiceById.mockResolvedValue(undefined);
  mockUpdateInvoice.mockResolvedValue(undefined);
  mockListSettings.mockResolvedValue([]);
  mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
  mockSendMail.mockResolvedValue({ messageId: "1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The customer picker.
// ---------------------------------------------------------------------------

describe("Admin → New booking with an existing customer", () => {
  it("books on the picked record and refreshes it with the fields the owner saw — corrections included", async () => {
    const result = await adminCaller().createBooking({
      customerId: 41,
      firstName: "Maria del Mar",
      lastName: "Prado",
      email: "maria.prado@example.com",
      phone: "2105550100", // she changed numbers; the owner fixed it in the prefilled field
      locale: "es",
      serviceType: "residential",
      sqft: 1200,
      sendEmail: false,
    });
    expect(result.reference).toMatch(/^GFC-/);
    expect(mockFindOrCreateCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 41, firstName: "Maria del Mar", phone: "2105550100", email: "maria.prado@example.com" })
    );
    expect(written().customerId).toBe(41);
  });

  it("a record id alone is enough for the form's contact floor", async () => {
    const result = await adminCaller().createBooking({ customerId: 41, firstName: "Maria del Mar", locale: "es", sendEmail: false });
    expect(result.reference).toMatch(/^GFC-/);
    expect(written().customerId).toBe(41);
    // Nothing to refresh from: the passthrough the brain write API relies on.
    expect(mockFindOrCreateCustomer).not.toHaveBeenCalled();
  });

  it("a customer typed in fresh is matched or created by contact, as before", async () => {
    await adminCaller().createBooking({ firstName: "Nuevo", phone: "5125550101", sendEmail: false });
    expect(mockFindOrCreateCustomer).toHaveBeenCalledWith(expect.objectContaining({ firstName: "Nuevo", phone: "5125550101" }));
    expect(mockFindOrCreateCustomer.mock.calls[0]![0].customerId).toBeUndefined();
    expect(written().customerId).toBe(7);
  });

  it("still needs a way to reach a new customer", async () => {
    await expect(adminCaller().createBooking({ firstName: "Nobody", sendEmail: false })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it("the module refreshes a picked record only when there is contact to refresh from", async () => {
    await createAdminBooking({ customerId: 41, firstName: "Maria del Mar", locale: "es" }, ORIGIN);
    expect(mockFindOrCreateCustomer).not.toHaveBeenCalled();
    await createAdminBooking({ customerId: 41, firstName: "Maria del Mar", email: "maria.prado@example.com", locale: "es" }, ORIGIN);
    expect(mockFindOrCreateCustomer).toHaveBeenCalledWith(expect.objectContaining({ customerId: 41 }));
  });

  it("the search finds a customer by phone, typed with or without punctuation", () => {
    const db = source("./db.ts");
    const search = db.slice(db.indexOf("export async function listCustomers"), db.indexOf("/** Customers by id"));
    expect(search).toContain("like(customers.phone, q)");
    expect(search).toContain("REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(");
    expect(search).toContain('search.replace(/\\D/g, "")');
  });

  it("the form searches the list, prefills every field from the pick, and sends the record id", () => {
    const dialog = source("../client/src/pages/admin/NewBookingDialog.tsx");
    expect(dialog).toContain('aria-label="Search existing customers"');
    expect(dialog).toContain("trpc.admin.customers.useQuery(");
    expect(dialog).toContain("enabled: open && customerId === null && debouncedSearch.length >= 2");
    for (const line of [
      "setName(`${customer.firstName} ${customer.lastName}`.trim());",
      'setPhone(customer.phone ?? "");',
      'setEmail(customer.email ?? "");',
      'setLocale(customer.preferredLocale === "es" ? "es" : "en");',
      'setAddress(customer.address ?? "");',
      'setCity(customer.city ?? "");',
      'setZip(customer.zip ?? "");',
    ]) {
      expect(dialog, line).toContain(line);
    }
    expect(dialog).toContain("customerId: customerId ?? undefined,");
    expect(dialog).toContain("New customer instead");
    // Reset clears the pick along with everything else.
    expect(dialog).toContain("setCustomerId(null);\n    setCustomerSearch(\"\");");
  });
});

// ---------------------------------------------------------------------------
// Test G — the invoice popout.
// ---------------------------------------------------------------------------

describe("admin.updateInvoiceReference", () => {
  const INVOICE = { id: 501, number: "INV-MFXK9Q-DEEP", customerId: 3, amount: 272, amountCents: 27200, status: "sent", serviceType: null, serviceDate: null };

  it("names the bill after the fact — service type and date, nothing about money", async () => {
    mockGetInvoiceById.mockResolvedValue(INVOICE);
    await adminCaller().updateInvoiceReference({ id: 501, serviceType: "deep", serviceDate: "2026-09-29" });
    expect(mockUpdateInvoice).toHaveBeenCalledWith(501, { serviceType: "deep", serviceDate: "2026-09-29" });
    const patch = mockUpdateInvoice.mock.calls[0]![1] as Record<string, unknown>;
    expect("amount" in patch || "amountCents" in patch || "status" in patch).toBe(false);
  });

  it("clears either part back to the plain 'Cleaning services' / no date", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, serviceType: "deep", serviceDate: "2026-09-29" });
    await adminCaller().updateInvoiceReference({ id: 501, serviceType: null, serviceDate: null });
    expect(mockUpdateInvoice).toHaveBeenCalledWith(501, { serviceType: null, serviceDate: null });
  });

  it("refuses an unknown invoice, an unknown service and a malformed date", async () => {
    await expect(adminCaller().updateInvoiceReference({ id: 999, serviceType: "deep", serviceDate: null })).rejects.toMatchObject({ code: "NOT_FOUND" });
    mockGetInvoiceById.mockResolvedValue(INVOICE);
    await expect(adminCaller().updateInvoiceReference({ id: 501, serviceType: "carpets" as never, serviceDate: null })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(adminCaller().updateInvoiceReference({ id: 501, serviceType: "deep", serviceDate: "09/29/2026" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mockUpdateInvoice).not.toHaveBeenCalled();
  });

  it("the invoices page opens the popout from the customer's name, on the table and on the cards", () => {
    const page = source("../client/src/pages/admin/AdminInvoices.tsx");
    expect(page.split("setCustomerPopout(inv)").length - 1).toBe(2);
    expect(page).toContain("<InvoiceCustomerDialog invoice={customerPopout} onClose={() => setCustomerPopout(null)} />");
    const dialog = source("../client/src/pages/admin/InvoiceCustomerDialog.tsx");
    expect(dialog).toContain("trpc.admin.customerDetail.useQuery(");
    expect(dialog).toContain("trpc.admin.updateInvoiceReference.useMutation(");
    expect(dialog).toContain("utils.admin.invoices.invalidate();");
    expect(dialog).toContain('id="inv-edit-service-type"');
    expect(dialog).toContain('id="inv-edit-service-date"');
    expect(dialog).toContain("CLEANING_TYPES.map(type =>");
    // Phone layout rules from PR C1: no dialog-level max-h, rows wrap.
    expect(dialog).toContain('<DialogContent className="rounded-2xl sm:max-w-md"');
    expect(dialog).toContain("break-words");
    expect(dialog).not.toContain("truncate");
  });
});

// ---------------------------------------------------------------------------
// Tap to text.
// ---------------------------------------------------------------------------

describe("the tap-to-text line", () => {
  it("builds an sms: link from however the number was typed, and none from nothing", () => {
    expect(smsHref("(210) 555-0123")).toBe("sms:+12105550123");
    expect(smsHref("+1 210 555 0123")).toBe("sms:+12105550123");
    expect(smsHref("210.555.0123")).toBe("sms:+12105550123");
    expect(smsHref("+44 20 7946 0958")).toBe("sms:+442079460958");
    expect(smsHref("")).toBeNull();
    expect(smsHref(null)).toBeNull();
    expect(smsHref("12345")).toBeNull();
  });

  it("the number and the name are public settings; the review link is not", async () => {
    expect(PUBLIC_SETTING_KEYS).toContain(TEXT_NUMBER_SETTING_KEY);
    expect(PUBLIC_SETTING_KEYS).toContain(TEXT_NAME_SETTING_KEY);
    expect(PUBLIC_SETTING_KEYS).not.toContain(REVIEW_URL_SETTING_KEY);
    mockListSettings.mockResolvedValue([
      { settingKey: TEXT_NUMBER_SETTING_KEY, settingValue: " (210) 555-0123 " },
      { settingKey: TEXT_NAME_SETTING_KEY, settingValue: "Karyme" },
      { settingKey: REVIEW_URL_SETTING_KEY, settingValue: "https://g.page/r/abc/review" },
    ]);
    const info = await publicContentRouter.createCaller({} as never).siteInfo();
    expect(info.text_number).toBe("(210) 555-0123");
    expect(info.text_name).toBe("Karyme");
    expect(Object.keys(info)).not.toContain(REVIEW_URL_SETTING_KEY);
  });

  it("the booking flow renders the link from the setting, named after whoever answers", () => {
    const booking = source("../client/src/pages/Booking.tsx");
    expect(booking).toContain("const textHref = smsHref(siteInfo.text_number);");
    expect(booking).toContain("{textHref && (");
    expect(booking).toContain('data-testid="text-us"');
    expect(booking).toContain('t.booking.textUs.replace("{name}", textName)');
    expect(booking).toContain("t.booking.textUsGeneric");
    expect(source("../client/src/i18n/translations/en.ts")).toContain('textUs: "Questions? Text {name} directly"');
    expect(source("../client/src/i18n/translations/es.ts")).toContain('textUs: "¿Preguntas? Envíe un mensaje de texto a {name}"');
    const hook = source("../client/src/hooks/useSiteInfo.ts");
    expect(hook).toContain('text_number: ""');
    expect(hook).toContain('text_name: ""');
  });
});
