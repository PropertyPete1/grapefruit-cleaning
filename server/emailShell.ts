/**
 * Branded HTML shell for customer emails.
 *
 * The older transactional emails are written as plain text and run through
 * wrapEmailHtml, which styles whole lines by guessing at their shape (an
 * ALL-CAPS line becomes a heading). That is fine for a receipt and not fine for
 * an email whose whole job is to feel like the business showing up — so the
 * status emails describe their content as structure and render it here.
 *
 * Constraints this markup is written against, in order:
 *   - Outlook on Windows renders through Word: tables for layout, no flexbox,
 *     no grid, no shorthand background, widths on the elements themselves.
 *   - Gmail strips <style> blocks in some contexts and all of it in the clipped
 *     view, so every rule is inline. No classes, no media queries.
 *   - Single column at max-width 560px with width:100%, which is what makes it
 *     readable on a phone without a media query.
 *   - Images are blocked by default in most desktop clients, so the header is a
 *     text wordmark on the brand coral rather than a logo file that may or may
 *     not load (and may or may not disappear against the coral).
 */

export const BRAND_CORAL = "#F26D5B";
export const BRAND_CREAM = "#FDF8F3";
const INK = "#2E2724";
const BODY_INK = "#3d3733";
const SOFT_INK = "#7a716b";
const FAINT_INK = "#9b918a";
const HAIRLINE = "#F0E6DE";
const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif";

/** One row of the details card. */
export interface EmailDetail {
  label: string;
  value: string;
}

/** A branded email described as content, not markup. */
export interface BrandedEmail {
  /** Sits under the subject in the inbox list. Never rendered in the body. */
  preheader: string;
  /** Small line above the wordmark divider, e.g. "Job started". */
  eyebrow: string;
  headline: string;
  /** Paragraphs between the headline and the details card. */
  intro: string[];
  detailsTitle: string;
  details: EmailDetail[];
  /**
   * Optional tinted callout — the review ask, say. `extraCtas` renders more
   * buttons stacked under the primary one (the tip email's preset amounts);
   * older emails simply leave it off and render exactly as before.
   */
  callout?: { text: string; ctaLabel: string; ctaUrl: string; extraCtas?: { label: string; url: string }[] };
  /** A second callout under the first, same rendering — tip ask + review ask can coexist. */
  secondaryCallout?: { text: string; ctaLabel: string; ctaUrl: string; extraCtas?: { label: string; url: string }[] };
  /** Paragraphs after the details card. */
  outro: string[];
  signOff: string[];
  /** Footer line under the card, e.g. the business phone. */
  footerNote?: string;
}

/** HTML-escapes a value for insertion into markup or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const paragraph = (text: string, marginTop: number) =>
  `<p style="margin:${marginTop}px 0 0;font-family:${FONT};font-size:15px;line-height:1.65;color:${BODY_INK};">${escapeHtml(text)}</p>`;

function detailsCard(title: string, details: EmailDetail[]): string {
  const rows = details
    .map(
      (detail, index) => `
            <tr>
              <td style="padding:${index === 0 ? 0 : 6}px 12px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${SOFT_INK};">${escapeHtml(detail.label)}</td>
              <td align="right" style="padding:${index === 0 ? 0 : 6}px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;font-weight:600;color:${INK};">${escapeHtml(detail.value)}</td>
            </tr>`
    )
    .join("");
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;background-color:${BRAND_CREAM};border-radius:12px;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 12px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND_CORAL};">${escapeHtml(title)}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
            </table>
          </td>
        </tr>
      </table>`;
}

function calloutBlock(callout: NonNullable<BrandedEmail["callout"]>): string {
  const button = (label: string, url: string, primary: boolean) => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:${primary ? 14 : 8}px auto 0;">
              <tr>
                <td style="background-color:${primary ? BRAND_CORAL : "#ffffff"};border:2px solid ${BRAND_CORAL};border-radius:999px;">
                  <a href="${escapeHtml(url)}" style="display:inline-block;padding:${primary ? "11px 26px" : "9px 24px"};font-family:${FONT};font-size:14px;font-weight:700;color:${primary ? "#ffffff" : BRAND_CORAL};text-decoration:none;">${escapeHtml(label)}</a>
                </td>
              </tr>
            </table>`;
  const extras = (callout.extraCtas ?? []).map(cta => button(cta.label, cta.url, false)).join("");
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;background-color:#FFF3F0;border-radius:12px;">
        <tr>
          <td style="padding:18px 20px;text-align:center;">
            <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.6;color:${BODY_INK};">${escapeHtml(callout.text)}</p>
            ${button(callout.ctaLabel, callout.ctaUrl, true)}${extras}
          </td>
        </tr>
      </table>`;
}

/** Renders a branded email to email-client-safe HTML. */
export function renderBrandedEmail(email: BrandedEmail): string {
  const intro = email.intro.map((text, i) => paragraph(text, i === 0 ? 0 : 12)).join("");
  const outro = email.outro.map(text => paragraph(text, 18)).join("");
  const signOff = email.signOff
    .map(
      (line, i) =>
        `<p style="margin:${i === 0 ? 22 : 0}px 0 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${BODY_INK};">${escapeHtml(line)}</p>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(email.headline)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND_CREAM};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:${BRAND_CREAM};">${escapeHtml(email.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND_CREAM};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
        <tr>
          <td style="background-color:${BRAND_CORAL};border-radius:16px 16px 0 0;padding:24px 28px;text-align:center;">
            <p style="margin:0;font-family:${FONT};font-size:21px;font-weight:800;letter-spacing:0.2px;color:#ffffff;">Grapefruit Cleaning Co.</p>
            <p style="margin:7px 0 0;font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#FFE0D9;">${escapeHtml(email.eyebrow)}</p>
          </td>
        </tr>
        <tr>
          <td style="background-color:#ffffff;padding:30px 28px 26px;">
            <h1 style="margin:0 0 14px;font-family:${FONT};font-size:22px;line-height:1.32;font-weight:700;color:${INK};">${escapeHtml(email.headline)}</h1>
            ${intro}${detailsCard(email.detailsTitle, email.details)}${email.callout ? calloutBlock(email.callout) : ""}${email.secondaryCallout ? calloutBlock(email.secondaryCallout) : ""}${outro}${signOff}
          </td>
        </tr>
        <tr>
          <td style="background-color:#ffffff;border-top:1px solid ${HAIRLINE};border-radius:0 0 16px 16px;padding:18px 28px;text-align:center;">
            <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${SOFT_INK};">${escapeHtml(email.footerNote ?? "")}</p>
          </td>
        </tr>
      </table>
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
        <tr>
          <td style="padding:16px 8px 0;text-align:center;">
            <p style="margin:0;font-family:${FONT};font-size:11px;line-height:1.6;color:${FAINT_INK};">© ${new Date().getFullYear()} Grapefruit Cleaning Co. — Premium home &amp; office cleaning</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * The same email as plain text, for the multipart alternative part. Clients
 * that refuse HTML, and screen readers set to prefer text, get the whole
 * message rather than a stub.
 */
export function renderBrandedEmailText(email: BrandedEmail): string {
  const calloutLines = (callout: NonNullable<BrandedEmail["callout"]>) => [
    ``,
    callout.text,
    `${callout.ctaLabel}: ${callout.ctaUrl}`,
    ...(callout.extraCtas ?? []).map(cta => `${cta.label}: ${cta.url}`),
  ];
  return [
    ...email.intro,
    ``,
    email.detailsTitle.toUpperCase(),
    ...email.details.map(d => `${d.label}: ${d.value}`),
    ...(email.callout ? calloutLines(email.callout) : []),
    ...(email.secondaryCallout ? calloutLines(email.secondaryCallout) : []),
    ...email.outro.flatMap(text => [``, text]),
    ``,
    ...email.signOff,
    ...(email.footerNote ? [``, email.footerNote] : []),
  ].join("\n");
}
