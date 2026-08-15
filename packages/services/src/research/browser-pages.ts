/**
 * Research-side Solari page loading. Search-engine HTML is a navigation
 * source only — evidence URLs are pages the session actually opened.
 * Unreviewed marketplace hosts are refused in the Solari compliance gate.
 */

export {
  loadQueryPagesFromEndpoints,
  openLoadedPagesViaCdp,
  searchPageUrls,
  isSearchHost,
  isSearchResultsPage,
  resolveResultUrl,
  selectResultUrls,
  assertNavigationPermitted,
  refuseUnreviewedHost,
  type LoadedBrowserPage,
  type SessionPageLoad,
} from '@foundry/providers';

import {
  isSearchResultsPage,
  type LoadedBrowserPage,
} from '@foundry/providers';

/**
 * Persistable research pages: http(s), actually loaded, not a search SERP.
 * Does not invent excerpts or titles.
 */
export function researchEvidencePages(loaded: readonly LoadedBrowserPage[]): readonly LoadedBrowserPage[] {
  const out: LoadedBrowserPage[] = [];
  for (const page of loaded) {
    let parsed: URL;
    try {
      parsed = new URL(page.url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    if (isSearchResultsPage(page.url)) continue;
    out.push({ url: parsed.toString(), title: page.title });
  }
  return out;
}
