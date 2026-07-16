import { trpc } from "@/lib/trpc";
import type { SiteInfo } from "@shared/const";

const EMPTY: SiteInfo = {
  business_phone: "",
  business_email: "",
  business_hours: "",
  service_area: "",
  instagram_url: "",
  facebook_url: "",
  stats_clients: "",
  stats_cleanings: "",
  stats_years: "",
  stats_rating: "",
};

/**
 * Live business info configured in Admin → Settings.
 * Values are empty strings until the owner fills them in — callers should
 * hide the corresponding UI element when a value is empty.
 */
export function useSiteInfo(): { info: SiteInfo; isLoading: boolean } {
  const query = trpc.content.siteInfo.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  return { info: query.data ?? EMPTY, isLoading: query.isLoading };
}

