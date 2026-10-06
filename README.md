# TailNow

One private service for publishing static apps to your Tailscale network and finding them in your app directory. The Mini Shortcuts dashboard is now part of TailNow, including external shortcuts, minimize/restore, removal, and optional standalone service shutdown.

## Run

Use Node 24.21 or newer on the 24.x line.

```sh
npm ci
cp tailnow.example.json tailnow.json
# Set your Tailscale hostname, absolute storage paths and external apps.
npm start
```

The service binds only to `127.0.0.1:8080`. `PORT` changes the port and `TAILNOW_CONFIG` selects a private configuration file. Include the corresponding local Host values in `allowedHosts`. `serviceLabel` identifies TailNow's own LaunchAgent and cannot be configured as a shutdown target.

Inspect existing routes before configuring Tailscale Serve:

```sh
tailscale serve status
tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve --bg --http=80 http://127.0.0.1:8080
```

With a device named `mini`, open `http://mini/` or its full HTTPS Tailscale address. Both entry points reach the same process. These commands replace the root handler for the selected port; preserve any existing nested handlers and other services. Never use `tailscale serve reset` to retire just one route. [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Publish

Choose **Publish an app** in the directory, enter an app address, and upload a ZIP containing `index.html` at its root. The app appears immediately after a successful upload. Reusing an address publishes a new version. Republishing a removed or stopped site returns it to the directory; updating a minimized site keeps it minimized.

The existing agent API remains compatible:

```sh
curl -F "file=@site.zip" https://mini.example-tailnet.ts.net/api/publish/my-app
```

The response retains `success`, `project`, `message`, and the actual HTTPS `url`. Static files remain available at `/<project>/` with nested paths, MIME types, HEAD and range requests. Project names accept 1–80 letters, numbers, underscores or hyphens; `api`, `_tailnow`, and `resume-data` are reserved. A configured external app cannot be overwritten by publishing a site with the same name.

Uploads allow one multipart `file`, at most 100 MiB compressed, 256 MiB expanded, 64 MiB per file, 5,000 entries, and 30 seconds of extraction. Absolute paths, traversal, symlinks, encrypted archives, case-insensitive duplicate paths and private dotfiles are rejected. Finder's `__MACOSX` and `.DS_Store` entries are ignored. ZIP the build directory's contents, not its containing directory.

## Directory controls

- **Minimize / Restore** organize the directory across devices and restarts.
- **Remove** hides the card and its bare `/<app>` shortcut. A hosted site's full `/<app>/` URL remains available.
- **Also shut down** unpublishes a hosted site and retains its files. Republish it to bring it back. For a configured standalone app, it disables and unloads its dedicated LaunchAgent and verifies that the job is gone.

Standalone app shutdown uses only the exact `service` mapping in the trusted configuration. No process IDs, shell commands, paths or labels are accepted from HTTP input. Configure dedicated app services only. Failed or interrupted shutdowns retain a visible retry record. Restarting a standalone service requires local administration; stop TailNow before removing its shutdown record from `catalog.json`.

`GET /api/apps` provides a catalog of current hosted sites and configured external apps. `GET /api/health` identifies the merged service. Management uses bodyless `POST /api/apps/<slug>/{minimize,restore,remove,shutdown}` with `X-Tailnow-Request: 1`; the old `X-Mini-Request: 1` header remains accepted. Browser uploads also require the custom header. Normal curl uploads remain unchanged.

## Architecture and storage

TailNow is a modular monolith: one Node process, one listener, one catalog, and no second directory service or polling API between services.

| Module | Responsibility |
| --- | --- |
| `src/http.js` | Request checks, APIs and static file dispatch |
| `src/catalog.js` | App discovery, lifecycle commands and a shared mutation lock |
| `src/state-store.js` | Validated private state and atomic catalog replacement |
| `src/publisher.js` / `extract-worker.js` | Staged, bounded extraction and release activation |
| `src/services.js` | Fixed, validated macOS LaunchAgent operations |
| `src/view.js` / `public/` | Directory rendering and browser controls |

`sitesDirectory` contains existing sites imported from TailNow. New uploads go to `dataDirectory/releases/<slug>/<release-id>/`. The private `catalog.json` selects active releases and stores directory state. Both change in a single atomic file replacement only after extraction succeeds. Failed updates leave the live version intact. Existing site directories and previous releases are retained; no uploaded content can reach the private data directory through HTTP.

Shutdown marks a site inactive in the catalog instead of deleting its files. Legacy sites with no release record continue to be discovered directly. Do not run another static server over the storage directories: it would bypass TailNow's release selection and shutdown records.

Run exactly one process per private data directory. Configuration and legacy directory discovery refresh after one second; publish and management commands invalidate this cache immediately. Invalid reloads fail closed until repaired. Changing storage locations requires a restart. Existing corrupt catalog state prevents startup.

This is not a multi-node database or a garbage collector. Keep the private data directory backed up and monitor disk space; old releases are retained intentionally. To recover a prior release, stop TailNow, back up `catalog.json`, select an existing release ID under `deployments[slug].release`, remove the corresponding shutdown/removal record if appropriate, and restart. To restore a legacy site, remove its deployment override while the service is stopped. The catalog file is flushed before atomic replacement; this is an atomic process-crash boundary, not a guarantee against every power-loss/filesystem failure.

## Migrating Mini Shortcuts

Keep a private backup of both apps, their LaunchAgents, configuration, state, sites and Tailscale Serve settings. Copy the application code and dependencies into a stable install directory outside the source checkout. Copy existing sites into a separate private storage directory and verify their contents.

With both old services stopped, `scripts/import-mini-shortcuts.js` can import their configuration and layout into an empty destination. Pass the path to a private JSON options file containing:

```json
{
  "miniConfigPath": "/absolute/path/to/Mini Shortcuts/apps.json",
  "miniStatePath": "/absolute/path/to/Mini Shortcuts/apps.state.json",
  "configPath": "/absolute/path/to/TailNow/tailnow.json",
  "sitesDirectory": "/absolute/path/to/TailNow/sites",
  "dataDirectory": "/absolute/path/to/TailNow/data",
  "allowedHosts": ["127.0.0.1:8080", "localhost:8080"],
  "serviceLabel": "com.example.tailnow"
}
```

```sh
node scripts/import-mini-shortcuts.js /private/path/to/options.json
```

The importer preserves external app configuration and minimized/removed state, removes obsolete loopback port entries, and refuses to overwrite an initialized destination. It does not modify the old configuration or copy site files.

Use `deploy/com.example.tailnow.plist.example` for the single LaunchAgent. Point HTTP port 80 and HTTPS port 443 at the merged listener while retaining other Serve handlers. After checking the directory, all existing apps, redirects and a full upload, disable and unload the old Mini Shortcuts job so it cannot restart at login. Keep its installed files and backed-up plist for rollback.

## Development

```sh
npm test
npm audit --omit=dev
```

Tests use disposable sites/configuration, mock service shutdown, and loopback listeners. They never stop installed apps or edit Tailscale routes. See [SECURITY.md](SECURITY.md) for the access boundary and limitations.
