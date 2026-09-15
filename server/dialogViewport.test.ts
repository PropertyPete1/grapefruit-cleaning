/**
 * Guards the dialog height contract.
 *
 * Every admin dialog used to be a fixed box centred on the screen with no height
 * limit and no scroll of its own. Radix's scroll lock cancels any wheel or touch
 * gesture that has no scroll container to land in, so a dialog taller than the
 * viewport — Create invoice with the add-on checklist and a few one-off charges,
 * about 1,460px — was cut off at both ends with its submit button unreachable,
 * on phones and on short desktop windows alike. A few pages had patched
 * themselves with max-h-[90vh], which iOS measures without its toolbars and
 * which ignores the on-screen keyboard entirely.
 *
 * The fix lives in the primitives, and these are the regressions that would
 * quietly undo it: a primitive losing its cap or its scroll, a page passing its
 * own max-h (tailwind-merge lets it win over the primitive's), and a tall form
 * dropping its pinned action back into the scrolling body. Source checks for the
 * markup (no DOM in this suite), a unit check for the viewport arithmetic.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import {
  DIALOG_VIEWPORT_CENTER_VAR,
  DIALOG_VIEWPORT_HEIGHT_VAR,
  dialogViewportVars,
} from "../client/src/lib/dialogViewport";

const CLIENT_SRC = fileURLToPath(new URL("../client/src", import.meta.url));
const UI_DIR = join(CLIENT_SRC, "components", "ui");
const ADMIN_DIR = join(CLIENT_SRC, "pages", "admin");
const readUi = (file: string) => readFileSync(join(UI_DIR, file), "utf-8");
const readAdmin = (file: string) => readFileSync(join(ADMIN_DIR, file), "utf-8");

/** The class string handed to cn() on the primitive's Content element. */
function contentClasses(source: string, slot: string): string {
  const start = source.indexOf(`data-slot="${slot}"`);
  expect(start, `${slot} not found`).toBeGreaterThan(-1);
  const classes = source.slice(start).match(/className=\{cn\(\s*(?:\/\/.*\n\s*)*"([^"]+)"/)?.[1];
  expect(classes, `${slot} has no base class string`).toBeTruthy();
  return classes!;
}

describe("the visible-viewport arithmetic", () => {
  it("caps at the visible height and centres on it", () => {
    // A 375x667 iPhone with the keyboard up leaves about 407px showing.
    expect(dialogViewportVars({ height: 407, offsetTop: 0 })).toEqual({
      [DIALOG_VIEWPORT_HEIGHT_VAR]: "407px",
      [DIALOG_VIEWPORT_CENTER_VAR]: "204px",
    });
  });

  it("follows the visual viewport when iOS pans it down to the focused field", () => {
    expect(dialogViewportVars({ height: 407, offsetTop: 260 })?.[DIALOG_VIEWPORT_CENTER_VAR]).toBe("464px");
  });

  it("ignores a momentarily negative offset from rubber-band overscroll", () => {
    expect(dialogViewportVars({ height: 600, offsetTop: -40 })?.[DIALOG_VIEWPORT_CENTER_VAR]).toBe("300px");
  });

  it("falls back to the class defaults rather than capping at nothing", () => {
    expect(dialogViewportVars({ height: 0, offsetTop: 0 })).toBeNull();
    expect(dialogViewportVars({ height: Number.NaN, offsetTop: 0 })).toBeNull();
    expect(dialogViewportVars({ height: 500, offsetTop: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe.each([
  ["dialog.tsx", "dialog-content"],
  ["alert-dialog.tsx", "alert-dialog-content"],
])("%s owns the dialog's height", (file, slot) => {
  const source = readUi(file);
  const classes = contentClasses(source, slot);

  it("caps the box at the visible viewport, through the variables the hook sets", () => {
    expect(classes).toContain(`max-h-[calc(var(${DIALOG_VIEWPORT_HEIGHT_VAR},100dvh)-2rem)]`);
    expect(classes).toContain(`top-[var(${DIALOG_VIEWPORT_CENTER_VAR},50%)]`);
    expect(classes).toContain("translate-y-[-50%]");
    // The old centring line, which is what pushed tall content off both ends.
    expect(classes).not.toContain("top-[50%]");
  });

  it("scrolls inside itself, so the scroll lock has somewhere to let a gesture land", () => {
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("overscroll-contain");
  });

  it("feeds the visual viewport to the element it caps", () => {
    expect(source).toContain('from "@/lib/dialogViewport"');
    expect(source).toContain("useVisibleViewportFit(contentNode)");
    expect(source).toContain("ref={contentRef}");
  });
});

describe("DialogFooter can pin its actions", () => {
  const source = readUi("dialog.tsx");
  const footer = source.slice(source.indexOf("function DialogFooter"), source.indexOf("function DialogTitle"));

  it("marks itself and sticks to the bottom on a solid bar", () => {
    expect(footer).toContain('data-sticky-footer={sticky ? "" : undefined}');
    expect(footer).toMatch(/sticky && "[^"]*\bsticky bottom-0\b/);
    expect(footer).toMatch(/sticky && "[^"]*\bbg-background\b/);
    // Bleeds over the content's p-6 so nothing scrolls past beside it.
    expect(footer).toMatch(/sticky && "[^"]*-mx-6 [^"]*px-6/);
  });

  it("is opt-in, so short dialogs keep their plain footer", () => {
    expect(footer).toContain("sticky = false");
  });

  it("has the content drop its bottom padding while one is present", () => {
    // Without this, bottom-0 would rest a padding's height above the edge and
    // content would show through underneath the bar.
    expect(contentClasses(source, "dialog-content")).toContain("has-[[data-sticky-footer]]:pb-0");
  });
});

/**
 * The attributes of every opening `<name ...>` tag, read brace-aware. A handler
 * such as `onInteractOutside={e => e.preventDefault()}` holds a `>` that a plain
 * `[^>]*` would stop at, cutting off a className that follows it.
 */
function openingTagAttributes(source: string, name: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(new RegExp(`<${name}\\b`, "g"))) {
    const start = match.index! + match[0].length;
    let depth = 0;
    let quote: string | null = null;
    let i = start;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
      } else if (ch === ">" && depth === 0) {
        break;
      }
    }
    found.push(source.slice(start, i));
  }
  return found;
}

/** A class token without its variant chain (`sm:`, `[&>div]:`) or `!` important marker. */
function utilityOf(token: string): string {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "[") depth++;
    else if (token[i] === "]") depth--;
    else if (token[i] === ":" && depth === 0) cut = i + 1;
  }
  return token.slice(cut).replace(/^!/, "");
}

/** Every class on a DialogContent/AlertDialogContent that takes sizing away from the primitive. */
function sizingViolations(attrs: string): string[] {
  // A computed class string could smuggle a cap past a literal check.
  if (/className=\{/.test(attrs)) return ["computed className"];
  const classes = attrs.match(/className="([^"]*)"/)?.[1];
  if (classes === undefined) return attrs.includes("className") ? ["unreadable className"] : [];
  return classes
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => {
      const utility = utilityOf(token);
      // Height, vertical position and scroll are the primitive's at every
      // breakpoint: a page max-h replaces its viewport cap in the class merge,
      // and even sm:overflow-visible ends internal scrolling on desktop.
      if (/^(max-h-|min-h-|h-|overflow-|top-|bottom-|inset-|translate-y-)/.test(utility)) return true;
      // An unprefixed max-w also replaces the primitive's phone gutter, leaving
      // a full-bleed dialog with no backdrop to tap, and still loses to
      // sm:max-w-lg on desktop. Widths go through a breakpoint prefix.
      return utility.startsWith("max-w-") && utility === token.replace(/^!/, "");
    });
}

describe("no page sizes its own dialog", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return path === UI_DIR ? [] : walk(path);
      return path.endsWith(".tsx") ? [path] : [];
    });
  }
  const usages = walk(CLIENT_SRC).flatMap(path => {
    const source = readFileSync(path, "utf-8");
    return (["DialogContent", "AlertDialogContent"] as const).flatMap(name =>
      openingTagAttributes(source, name).map(attrs => ({ where: `${relative(CLIENT_SRC, path)} <${name}>`, attrs }))
    );
  });

  it("finds the dialogs to check", () => {
    expect(usages.length).toBeGreaterThanOrEqual(20);
  });

  it("reads past handlers and through breakpoint prefixes", () => {
    // The two ways a cap used to slip past this check.
    const [attrs] = openingTagAttributes(
      '<DialogContent onInteractOutside={e => e.preventDefault()} className="rounded-2xl sm:overflow-visible sm:max-w-md">x</DialogContent>',
      "DialogContent"
    );
    expect(attrs).toContain('className="rounded-2xl sm:overflow-visible sm:max-w-md"');
    expect(sizingViolations(attrs)).toEqual(["sm:overflow-visible"]);
    expect(sizingViolations(' className="max-h-[90vh] max-w-3xl [&>div]:overflow-hidden"')).toEqual([
      "max-h-[90vh]",
      "max-w-3xl",
      "[&>div]:overflow-hidden",
    ]);
    expect(sizingViolations(" className={cn(open && \"p-0\")}")).toEqual(["computed className"]);
    expect(openingTagAttributes("<AlertDialogContent>", "DialogContent")).toEqual([]);
  });

  it.each(usages.map(u => [u.where, u.attrs]))("%s", (_where, attrs) => {
    expect(sizingViolations(attrs)).toEqual([]);
  });
});

describe("tall forms keep their action on screen", () => {
  /** The primary action's label, and the dialog-bearing file it lives in. */
  const ACTIONS: [string, string][] = [
    ["AdminInvoices.tsx", '"Recording…" : `Record ${fmtMoney'],
    ["AdminInvoices.tsx", "`Approve & send ${fmtMoney"],
    ["AdminInvoices.tsx", "`Create & send ${fmtMoney"],
    ["NewBookingDialog.tsx", '"Create booking & get link"'],
    ["AdminProperties.tsx", '"Validate feed & connect"'],
    ["RescheduleRequestsPanel.tsx", "Send counter"],
    ["AddonCatalogManager.tsx", "Save category"],
    ["AddonCatalogManager.tsx", "Save add-on"],
    ["AdminBlog.tsx", '"Create post"'],
    ["AdminCoupons.tsx", '"Create coupon"'],
    ["AdminEmployees.tsx", '"Add member"'],
    ["AdminGallery.tsx", '"Add image"'],
    ["BookingDetails.tsx", "Save contact"],
  ];

  it.each(ACTIONS)("%s: %s sits inside a sticky DialogFooter", (file, label) => {
    const source = readAdmin(file);
    const at = source.lastIndexOf(label);
    expect(at, "label not found").toBeGreaterThan(-1);
    const opened = source.lastIndexOf("<DialogFooter sticky>", at);
    expect(opened, "no sticky footer before the action").toBeGreaterThan(-1);
    expect(source.slice(opened, at)).not.toContain("</DialogFooter>");
  });
});
