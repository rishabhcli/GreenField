export * from './http/client.js';
export * from './http/rate-limit.js';
export * from './http/adapter.js';
export * from './http/webhook-verify.js';
export * from './manifests.js';
export * from './registry.js';

// Provider adapters. Each directory owns its own barrel; adding a provider
// means adding a line here and a factory in the registry wiring.
export * from './stripe/index.js';
export * from './anthropic/index.js';
export * from './render/index.js';
export * from './band/index.js';
export * from './cloudflare/index.js';
// Meta and Google both define `CreateCampaignInput` and `ToMetricSnapshotInput`
// with platform-specific fields. They are namespaced rather than merged: a
// Google campaign shape is not a Meta campaign shape, and flattening them would
// let a caller pass one where the other is required.
export * as GoogleAds from './google-ads/index.js';
export { GoogleAdsAdapter } from './google-ads/index.js';
export * from './images/index.js';
export * from './linq/index.js';
export * as MetaAds from './meta-ads/index.js';
export { MetaAdsAdapter } from './meta-ads/index.js';
export * from './replay/index.js';
export * from './resend/index.js';
export * from './shippo/index.js';
export * from './sourcing/index.js';
export * from './terac/index.js';
export * from './solari/index.js';
export { SuperserveAdapter } from './superserve/index.js';
export * as Superserve from './superserve/index.js';
export {
  DodoAdapter,
  mapDodoEventToOrderTransition,
  refusePhysicalGoods,
  dodoRefundLedgerId,
} from './dodo/index.js';
export { WhopAdapter, mapWhopEventToOrderTransition, WHOP_API_VERSION_DATE } from './whop/index.js';
export { LovableAdapter } from './lovable/index.js';
export { Sandbox0Adapter } from './sandbox0/index.js';
export * as Sandbox0 from './sandbox0/index.js';
export * from './brave-search/index.js';
export * from './reddit/index.js';
export * from './pioneer/index.js';
export * from './egoist/index.js';
