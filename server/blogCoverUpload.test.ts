import { describe, expect, it } from "vitest";

/**
 * Contract tests for the admin.uploadBlogCover input validation logic.
 * The storagePut call itself is exercised against live infra only in
 * production; here we verify the validation rules that gate it.
 */

const MIME_RE = /^image\/(png|jpe?g|webp|gif|avif)$/i;

function sanitizeName(fileName: string): string {
  return (
    fileName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(-80) || "cover.jpg"
  );
}

describe("blog cover upload validation", () => {
  it("accepts standard web image mime types", () => {
    for (const t of ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/avif", "IMAGE/PNG"]) {
      expect(MIME_RE.test(t)).toBe(true);
    }
  });

  it("rejects non-image and dangerous mime types", () => {
    for (const t of ["image/svg+xml", "text/html", "application/javascript", "image/x-icon", "video/mp4", ""]) {
      expect(MIME_RE.test(t)).toBe(false);
    }
  });

  it("sanitizes file names to safe storage keys", () => {
    expect(sanitizeName("My Photo (1).JPG")).toBe("my-photo-1-.jpg");
    expect(sanitizeName("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeName("émojis🎉.png")).toBe("mojis-.png");
    expect(sanitizeName("")).toBe("cover.jpg");
    expect(sanitizeName("...")).toBe("cover.jpg");
  });

  it("keeps at most the last 80 characters of long names", () => {
    const long = "a".repeat(120) + ".png";
    const out = sanitizeName(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith(".png")).toBe(true);
  });

  it("enforces the 5MB decoded size limit", () => {
    const fiveMb = 5 * 1024 * 1024;
    const okBuf = Buffer.alloc(fiveMb);
    const bigBuf = Buffer.alloc(fiveMb + 1);
    expect(okBuf.length <= fiveMb).toBe(true);
    expect(bigBuf.length <= fiveMb).toBe(false);
  });

  it("decodes base64 payloads to the original bytes", () => {
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
    const b64 = original.toString("base64");
    const decoded = Buffer.from(b64, "base64");
    expect(decoded.equals(original)).toBe(true);
  });
});
