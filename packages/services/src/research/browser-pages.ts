/**
 * Drive a Solari (or other CDP) browser session and report pages that actually
 * loaded. Search-engine HTML is used only as a navigation source — result URLs
 * are recorded after the session opens them, never invented.
 */

export {
  loadQueryPagesFromEndpoints,
  openLoadedPagesViaCdp,
  searchPageUrls,
  isSearchHost,
  isSearchResultsPage,
  resolveResultUrl,
  type LoadedBrowserPage,
  type SessionPageLoad,
} from '@foundry/providers';
