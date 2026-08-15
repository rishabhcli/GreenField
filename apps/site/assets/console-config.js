/* ============================================================================
   OPERATOR CONSOLE — DEPLOYMENT CONFIG

   `apps/site` is served as static assets with no build step, so there is no
   place to inject an environment variable. Set the deployed API's base URL
   here and commit it; it is a public URL, not a secret.

   On Render the site (`foundry-site`) and the API (`foundry-api`) are different
   hosts. An empty value used to fall back to the page origin, so the console
   fetched `/readiness/company` from the static service and got HTTP 404.

   Resolution order, most explicit first:
     1. ?api=https://…   (persisted only if the origin is this allowlisted host)
     2. localStorage      (ignored unless it is this host)
     3. this value
     4. the same baked default inside console.js
     5. localhost:3000 when opened from a file:// or a localhost page
============================================================================ */
window.YELLOFIELD_API_BASE = 'https://foundry-api-8ih0.onrender.com';
