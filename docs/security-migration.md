# Upgrade an existing installation to isolated apps

Version 3 fails closed if hosted apps lack isolated origins. Prepare and test the migration before replacing the running service. Use a fresh administrator origin: reusing the old shared address would expose sign-in to previously hosted scripts and service workers.

1. Back up the configuration, catalog, application releases, service definition, and `tailscale serve status --json`. Record existing standalone services and their ports. Preserve visibility, ordering, and stopped deployments. Install patched Node 24.22.3 or newer in the 24.x series.
2. Prepare an options JSON outside the checkout, using absolute paths:

   ```json
   {
     "configPath": "/private/TailNow/tailnow.json",
     "outputPath": "/private/TailNow/tailnow.v3.json",
     "adminPort": 8446,
     "firstAppPort": 8500,
     "reservedPorts": [8443, 8444, 8445],
     "siteOptions": {}
   }
   ```

   Run `node scripts/migrate-security.js /private/migration-options.json`. The helper writes a new config without changing the source, content, or catalog. It assigns a distinct origin to every discovered or previously deployed app, including stopped ones, avoids existing linked-service ports, and preserves external app configuration. Inspect the result and confirm that no assigned port is used by another Tailscale handler. Missing or malformed inputs fail without replacing the old config.
3. Inventory browser storage and app integrations. Add exact app-owned localStorage keys, deliberate static dependencies, and required backend proxies in `siteOptions`, for example:

   ```json
   {
     "photo-review": {
       "storageKeys": ["photo-review-decisions-v1"],
       "dependencies": ["photo-assets"]
     },
     "worksheet": {
       "storageKeys": ["worksheet-draft-v1"],
       "apiProxies": [{
         "prefix": "/worksheet-data/",
         "target": "http://127.0.0.1:8797",
         "methods": ["GET", "PATCH"]
       }]
     }
   }
   ```

   Dependencies allow files to be fetched under the consuming app's origin, such as `/photo-assets/image.jpg`. Rewrite hard-coded old shared-origin asset URLs to these relative URLs in a new release of the consuming app. Other app links should point to their assigned origins. Do not grant unrelated apps as dependencies merely to silence a failed request. Keep a backup of the original release.
4. Stage the new code with `npm ci --omit=dev --ignore-scripts`. Test against a copy of the configuration and data using separate loopback ports. Verify the directory, static resources, saved-data migration, relevant backend reads/writes using synthetic data, and external links. Confirm that stopped apps stay stopped and an app cannot read another app's files or manage the directory.
5. Configure the new HTTPS listeners using [Tailscale Serve](https://tailscale.com/docs/reference/examples/serve). Each assigned port forwards to the same loopback TailNow process; TailNow dispatches by the original Host header. For example:

   ```sh
   tailscale serve --bg --https=8446 http://127.0.0.1:8080
   tailscale serve --bg --https=8500 http://127.0.0.1:8080
   ```

   Configure every assigned app port, preserve unrelated handlers, and check tailnet access rules for the new ports. Do not enable Funnel. If an old shared path directly proxies an app backend, remove that forwarding route after verifying the new app-specific proxy; leaving it in place bypasses isolation.
6. Stop the old process before changing the live config and code. Start the new service with the patched Node executable and `TAILNOW_CONFIG` pointing at the prepared config. Do not run two processes against the same catalog. Keep the old root listener forwarding to TailNow: it now redirects to the fresh admin origin, while old app links redirect or migrate saved preferences.
7. Verify the real HTTPS URLs, unauthenticated mutation rejection, old API closure, and the external services. Retrieve the admin key locally with `node scripts/admin-key.js --config /private/TailNow/tailnow.v3.json --show` and enter it only at the new administrator address. Do not paste the key into chat, shell arguments, URLs, or Git. The helper without `--show` prints only its file location.

Saved localStorage is browser-specific. To migrate it, visit each app's **old HTTPS root link in the same browser/profile** that holds the saved values, then let TailNow open the new app address. Update bookmarks afterward. Revisit old links safely: newer destination values are never overwritten. If migration fails, the old copy remains. Cross-host migrations require manual export/import; automatic transfer is limited to ports on the same HTTPS hostname. Temporary session state and cookies are not transferred.

Keep each app's origin permanently assigned, even while stopped. New publishing requires adding an unused `siteOrigins` entry and its Tailscale listener first. The catalog records ownership so a future config change cannot silently expose an old app's browser data to a different app. Backup and restore that history with the catalog.

For rollback, stop the new process, restore the configuration, service definition, and recorded Serve routes, then start the previous release. Restore the catalog backup only if no legitimate changes occurred after the backup. A rollback also restores the previous security weaknesses; use it only to recover availability while correcting the migration.
