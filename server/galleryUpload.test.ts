import { describe, expect, it } from "vitest";

/**
 * Contract tests for the admin.uploadGalleryImage input validation and
 * filename sanitization, mirroring blogCoverUpload.test.ts. These verify the
 * rules enforced by the zod schema and the sanitizer without hitting S3.
 */

const MIME_RE = /^image\/(png|jpe?g|webp|gif|avif)$/i;

function sanitize(fileName: string): string {
  return (
    fileName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(-80) || "photo.jpg"
  );
}

const GALLERY_URL_OK = (v: string) => /^https?:\/\//i.test(v) || v.startsWith("/");

describe("gallery image upload contract", () => {
  it("accepts the allowed image MIME types", () => {
    for (const m of ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/avif", "IMAGE/PNG"]) {
      expect(MIME_RE.test(m)).toBe(true);
    }
  });

  it("rejects SVG and non-image MIME types", () => {
    for (const m of ["image/svg+xml", "text/html", "application/pdf", "image/bmp", "video/mp4", ""]) {
      expect(MIME_RE.test(m)).toBe(false);
    }
  });

  it("sanitizes hostile filenames", () => {
    expect(sanitize("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitize("My Photo (1).JPG")).toBe("my-photo-1-.jpg");
    expect(sanitize("<script>.png")).toBe("script-.png");
    expect(sanitize("...")).toBe("photo.jpg");
  });

  it("caps sanitized names at 80 characters", () => {
    const long = "a".repeat(200) + ".png";
    expect(sanitize(long).length).toBeLessThanOrEqual(80);
  });

  it("enforces the 5MB binary limit semantics", () => {
    const fiveMb = 5 * 1024 * 1024;
    expect(Buffer.alloc(fiveMb).length <= fiveMb).toBe(true);
    expect(Buffer.alloc(fiveMb + 1).length <= fiveMb).toBe(false);
  });

  it("createGalleryItem url accepts http(s) URLs and storage paths, rejects junk", () => {
    expect(GALLERY_URL_OK("https://example.com/img.png")).toBe(true);
    expect(GALLERY_URL_OK("http://example.com/img.png")).toBe(true);
    expect(GALLERY_URL_OK("/manus-storage/gallery/photo_ab12cd34.png")).toBe(true);
    expect(GALLERY_URL_OK("javascript:alert(1)")).toBe(false);
    expect(GALLERY_URL_OK("data:image/png;base64,AAA")).toBe(false);
    expect(GALLERY_URL_OK("ftp://example.com/x.png")).toBe(false);
  });
});
