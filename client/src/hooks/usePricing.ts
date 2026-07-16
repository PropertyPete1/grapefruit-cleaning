import { DEFAULT_PRICING, type PricingConfig } from "@shared/pricing";
import { trpc } from "@/lib/trpc";

/**
 * Live pricing configuration, admin-editable in Admin → Services & Pricing.
 * Falls back to the built-in defaults while loading so pages render instantly.
 */
export function usePricing(): PricingConfig {
  const { data } = trpc.booking.pricingConfig.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  return data ?? DEFAULT_PRICING;
}
