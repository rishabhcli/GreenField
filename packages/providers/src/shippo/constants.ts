/**
 * Shippo auth header — confirmed 2026-08-15 via WebSearch and a direct
 * WebFetch of `docs.goshippo.com/docs/Guides_general/authentication`.
 *
 * Confirmed format: `Authorization: ShippoToken <API_TOKEN>` — **not**
 * `Bearer`. This is the same for both modes; only the token's own prefix
 * differs (`shippo_live_...` vs `shippo_test_...`, matching
 * `SECRETS.shippoApiToken.detectMode` in `manifests.ts`, which was already
 * correct). The OAuth-connected-carrier-account flow separately documents a
 * `Bearer oauth....` form, but that is for a different credential and is out
 * of scope here — this adapter authenticates with the account's own API
 * token, so the header format below is the one that applies.
 */
export const SHIPPO_AUTH_SCHEME = 'ShippoToken';
