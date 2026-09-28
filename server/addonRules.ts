/**
 * The duplicate add-on refusal, server side. The rule — which add-on each
 * service already includes — is shared/addonRules.ts; this only adds the
 * error, worded with the same names the customer's emails use.
 */
import { TRPCError } from "@trpc/server";
import { duplicateAddonMessage, duplicateAddons } from "@shared/addonRules";
import { EXTRA_NAMES, SERVICE_NAMES } from "./names";

/**
 * Refuses an add-on the chosen service already includes. No add-on list
 * offers one, so this fires only on a crafted or stale request — and it
 * must, because the alternative is charging the same work twice.
 */
export function assertNoDuplicateAddons(
  serviceType: string | null | undefined,
  keys: readonly string[],
  locale: "en" | "es" = "en"
): void {
  const duplicates = duplicateAddons(serviceType, keys);
  if (duplicates.length === 0) return;
  const key = duplicates[0]!;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: duplicateAddonMessage({
      addonName: EXTRA_NAMES[key]?.[locale] ?? key,
      serviceName: SERVICE_NAMES[serviceType ?? ""]?.[locale] ?? String(serviceType),
      locale,
    }),
  });
}
