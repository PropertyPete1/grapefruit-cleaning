/**
 * The notes column carries two authors: the owner first, the customer later,
 * split by a labeled marker. What is pinned here is the append-not-overwrite
 * contract — the owner's notes survive every customer submission verbatim —
 * and that re-submitting replaces the customer section instead of stacking.
 */
import { describe, expect, it } from "vitest";
import { adminNotesOf, CUSTOMER_NOTES_LABEL, customerNotesOf, mergeCustomerNotes } from "./notesMerge";

const ADMIN = "Quoted high — haggler.\nGate code in CRM.";

describe("mergeCustomerNotes", () => {
  it("appends under the label, never overwriting the owner's notes", () => {
    const merged = mergeCustomerNotes(ADMIN, "Dog in the yard, gate code 4411");
    expect(merged.startsWith(ADMIN)).toBe(true);
    expect(merged).toContain(`${CUSTOMER_NOTES_LABEL} Dog in the yard, gate code 4411`);
  });

  it("stands alone when the owner wrote nothing", () => {
    expect(mergeCustomerNotes(null, "Park in the alley")).toBe("From customer: Park in the alley");
    expect(mergeCustomerNotes("", "Park in the alley")).toBe("From customer: Park in the alley");
  });

  it("replaces the previous customer section on re-submission instead of stacking", () => {
    const first = mergeCustomerNotes(ADMIN, "First thought");
    const second = mergeCustomerNotes(first, "Better thought");
    expect(second).toBe(`${ADMIN}\n\n${CUSTOMER_NOTES_LABEL} Better thought`);
    expect(second.match(/From customer:/g)).toHaveLength(1);
  });

  it("clears the section when the customer clears the field", () => {
    const withNote = mergeCustomerNotes(ADMIN, "Never mind this");
    expect(mergeCustomerNotes(withNote, "")).toBe(ADMIN);
    expect(mergeCustomerNotes(withNote, "   ")).toBe(ADMIN);
  });

  it("survives a customer whose text contains the label itself", () => {
    const sneaky = mergeCustomerNotes(ADMIN, "From customer: not really, just quoting");
    // The FIRST label at a line start is the boundary; the admin part stays intact.
    expect(adminNotesOf(sneaky)).toBe(ADMIN);
    const replaced = mergeCustomerNotes(sneaky, "Cleaner text");
    expect(replaced).toBe(`${ADMIN}\n\n${CUSTOMER_NOTES_LABEL} Cleaner text`);
  });

  it("does not mistake a mid-sentence mention in the owner's notes for the boundary", () => {
    const tricky = "Customer said 'From customer: is a weird phrase' on the phone.";
    expect(adminNotesOf(tricky)).toBe(tricky);
    expect(customerNotesOf(tricky)).toBe("");
  });
});

describe("the two halves", () => {
  it("splits a merged column back into its authors", () => {
    const merged = mergeCustomerNotes(ADMIN, "Key under the mat");
    expect(adminNotesOf(merged)).toBe(ADMIN);
    expect(customerNotesOf(merged)).toBe("Key under the mat");
  });

  it("reads an unlabeled column as all owner", () => {
    expect(adminNotesOf(ADMIN)).toBe(ADMIN);
    expect(customerNotesOf(ADMIN)).toBe("");
    expect(customerNotesOf(null)).toBe("");
  });
});
