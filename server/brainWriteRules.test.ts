/**
 * The brain write API's pure rules, pinned without a database: what a matched
 * customer row may learn from a write (blanks only — the no-overwrite guard
 * the spec demands), and how an attribution line joins a booking's notes
 * without disturbing the customer-written section.
 */
import { describe, expect, it } from "vitest";
import { customerFillsFor, withAuditLine } from "./brainWriteRules";

const FULL_ROW = {
  lastName: "Marquez",
  email: "rosa@example.com",
  phone: "+1 210 555 0100",
  address: "4411 Hidden Gate Rd",
  city: "San Antonio",
  zip: "78201",
};

describe("customerFillsFor — the no-overwrite guard", () => {
  it("never overwrites a non-empty field, even with a different value offered", () => {
    const fills = customerFillsFor(FULL_ROW, {
      lastName: "Fields",
      email: "other@example.com",
      phone: "+1 210 555 9999",
      address: "1 Elsewhere St",
      city: "Austin",
      zip: "73301",
    });
    expect(fills).toEqual({});
  });

  it("fills exactly the blanks and nothing else", () => {
    const fills = customerFillsFor(
      { lastName: "", email: null, phone: "+1 210 555 0100", address: null, city: "San Antonio", zip: null },
      { lastName: "Marquez", email: "rosa@example.com", phone: "+1 210 555 8888", zip: "78201" }
    );
    expect(fills).toEqual({ lastName: "Marquez", email: "rosa@example.com", zip: "78201" });
  });

  it("offers nothing when the write brought nothing new", () => {
    expect(
      customerFillsFor({ lastName: "", email: null, phone: null, address: null, city: null, zip: null }, {})
    ).toEqual({});
  });
});

describe("withAuditLine — attribution stays on the staff side of the notes", () => {
  it("is the whole notes column when there were none", () => {
    expect(withAuditLine(null, "[via PRIMARY — Karyme] cancelled this booking")).toBe(
      "[via PRIMARY — Karyme] cancelled this booking"
    );
  });

  it("appends after the owner's notes", () => {
    expect(withAuditLine("haggler, quoted high", "[via PRIMARY — Karyme] rescheduled to 2026-09-02 14:00")).toBe(
      "haggler, quoted high\n[via PRIMARY — Karyme] rescheduled to 2026-09-02 14:00"
    );
  });

  it("lands BEFORE the customer section, which survives verbatim", () => {
    const merged = withAuditLine(
      "gate code 4411\n\nFrom customer: please skip the garage",
      "[via PRIMARY — Karyme] rescheduled to 2026-09-02 14:00"
    );
    expect(merged).toBe(
      "gate code 4411\n[via PRIMARY — Karyme] rescheduled to 2026-09-02 14:00\n\nFrom customer: please skip the garage"
    );
  });

  it("opens an admin section when the column was customer-only", () => {
    const merged = withAuditLine("From customer: side door please", "[via PRIMARY — Karyme] cancelled this booking");
    expect(merged).toBe("[via PRIMARY — Karyme] cancelled this booking\n\nFrom customer: side door please");
  });
});
