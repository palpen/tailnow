# TailNow security model

TailNow runs on IPv4 loopback behind Tailscale Serve. Tailscale policy decides which clients can reach it. Every allowed client can view, publish and manage apps; there is no separate administrator role or per-app access control. Local administrators and configuration writers are trusted. Do not expose it through Funnel, public proxies, or router port forwarding.

Published applications share the TailNow HTTPS origin and must be trusted. Their scripts have the same browser privileges as the directory, including the ability to call its APIs. The Host allowlist, Origin checks and custom request header block unrelated websites; they are not a sandbox between hosted applications. Host checks are also not client authentication. Pigeon and other external services retain their own access controls.

The short HTTP address relies on Tailscale's encrypted transport and is not an HTTPS browser secure context. Fixed configured app destinations and returned publication URLs use HTTPS. Request headers and query parameters cannot choose redirect destinations. The application does not fetch destination content.

Directory HTML escapes configuration text and uses a restrictive CSP without inline scripts or styles. Hosted content receives its own ordinary static response, so existing app scripts and styles keep working. Source, configuration, state, old releases, symlinks and dotfiles are not exposed by the file dispatcher. Errors omit filesystem paths, command output and parser diagnostics.

All mutations share a process lock. ZIP uploads are written outside served paths, validated and extracted in a worker with a deadline, bounded input size, entry count, per-file expansion and total expansion. Decompression has an independent output limit and CRC validation. A failed upload cannot remove the active app. One atomic catalog update selects the new release and updates directory visibility. Removal precedes standalone service shutdown; failure leaves a retry record. State writes are private mode 0600 and flushed before rename.

Standalone shutdown invokes `/bin/launchctl` without a shell, using only validated local labels in the service account's GUI domain. TailNow's own configured/current service label is rejected. Disabling the job prevents KeepAlive or login from restarting it; bootout and print confirm unloading. Shared infrastructure must never be assigned as an app shutdown target.

A reachable malicious client can still fill retained release storage or consume resources. Connection limits, timeouts and a single upload at a time bound concurrent work, but are not quotas or a complete rate limiter. Previous releases and failed-worker remnants after a hard process kill may consume disk until a local administrator removes them. Back up the data directory and run only one process per catalog.

Node 24 LTS and npm lockfile dependencies should be kept current. Upload limits use [Multer's documented request limits](https://expressjs.com/en/resources/middleware/multer/). Automated integration tests cover upload failures, malicious archives, lifecycle persistence, request checks, migration and startup privacy. These checks are not an independent penetration test or an audit of destination apps or Tailscale policy.
