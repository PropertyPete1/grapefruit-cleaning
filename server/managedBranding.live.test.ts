import { describe, expect, it } from "vitest";

const runLive = process.env.RUN_LIVE_BRANDING_TEST === "1";
const suite = runLive ? describe : describe.skip;

suite("managed Grapefruit app branding", () => {
  it("points VITE_APP_LOGO at the existing square Grapefruit PNG and the asset is reachable", async () => {
    const logoPath = process.env.VITE_APP_LOGO;
    expect(logoPath).toBe("/manus-storage/favicon-256_0edfb26b.png");

    const response = await fetch(`https://grapeclean-skvabkkr.manus.space${logoPath}`);
    expect(response.status).toBe(200);
    expect(["image/png", "application/octet-stream"]).toContain(
      response.headers.get("content-type")?.split(";")[0]
    );

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
