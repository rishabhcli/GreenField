/* ============================================================================
   OPERATOR CONSOLE — DEPLOYMENT CONFIG

   `apps/site` is served as static assets with no build step, so there is no
   place to inject an environment variable. Set the deployed API's base URL
   here and commit it; it is a public URL, not a secret.

   Leave it empty and the console falls back to its own origin, which is correct
   only when the API and the site are served from the same host. On Render they
   are not: the site is `foundry-site` and the API is `foundry-api`.

   Resolution order, most explicit first:
     1. ?api=https://…   (persisted to localStorage, so a bookmark keeps working)
     2. localStorage      (whatever was last set via the query param)
     3. this value
     4. the page's own origin, or localhost:3000 when opened from a file://
============================================================================ */
window.YELLOFIELD_API_BASE = '';
