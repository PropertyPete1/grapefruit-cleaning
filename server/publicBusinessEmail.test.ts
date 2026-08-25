import { describe, expect, it } from "vitest";
import { localBusinessJsonLd } from "../client/src/hooks/useSeo";

describe("public business email rendering", () => {
  it("puts the configured business_email into LocalBusiness JSON-LD", () => {
    const schema = localBusinessJsonLd({
      business_email: "Grapefruitcleaningc@gmail.com",
    });

    expect(schema.email).toBe("Grapefruitcleaningc@gmail.com");
  });

  it("does not invent or hardcode an email when the setting is empty", () => {
    const schema = localBusinessJsonLd({ business_email: "" });

    expect(schema).not.toHaveProperty("email");
  });
});
