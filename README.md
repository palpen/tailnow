# TailNow

TailNow is a private home for your web apps. Publish static websites, add links to other apps, and find them all in one directory on your Tailscale network. Open it from your connected devices, then reorder, minimize, or restore apps to keep things tidy.

[![TailNow’s app directory showing example apps and reorder controls.](docs/images/tailnow-demo.png)](docs/images/tailnow-demo.png)

## Before you start

- **Tailscale:** [Download Tailscale](https://tailscale.com/download), create an account, and sign in on the computer running TailNow and each device you want to access it from. Keep the host computer awake and connected.
- **Claude Code or Codex:** Run your coding agent on the computer where you want to install TailNow.
- **Git and Node.js:** TailNow requires Node **24.21 or newer within the 24.x series**, with npm. The prompt below asks your agent to check and install these tools if needed.

## Install and run

**Copy and paste this prompt into Claude Code or Codex:**

```text
Install and run TailNow on this computer from https://github.com/palpen/tailnow.git.

1. Check that Git, Node.js >=24.21.0 <25, and npm are installed. Install any
   missing tools using a suitable method for my operating system. Check that
   Tailscale is installed, signed in, and connected; guide me through any
   sign-in or account settings that require my action.
2. Clone the repository into a suitable local folder, enter it, read its setup
   and security instructions, and run npm ci. Preserve any existing installation.
3. Create tailnow.json from tailnow.example.json. Detect this computer's actual
   Tailscale DNS name and use its HTTPS address for baseUrl. Set allowedHosts
   to include that hostname, localhost:8080, and 127.0.0.1:8080. Use separate
   absolute paths for sitesDirectory and dataDirectory outside the checkout,
   with private data outside the served sites directory. Keep a valid
   serviceLabel and set apps to [] to remove the example app. Do not overwrite
   existing configuration or data.
4. Start TailNow with npm start on 127.0.0.1:8080. Inspect tailscale serve status,
   then configure Tailscale Serve to forward HTTPS to that local address.
   Preserve existing routes and services; if the address or port is in use,
   resolve the conflict with me. Help me enable Tailscale HTTPS if needed.
   Keep access private to Tailscale; do not enable Funnel or public forwarding.
5. Verify /api/health locally and through the Tailscale HTTPS address, and check
   that the app directory loads. Leave TailNow running, give me the URL to open
   on my connected devices, and explain how to stop and restart it. Tell me
   whether it will restart automatically after a reboot.
```

Anyone your Tailscale access rules allow to reach TailNow can view, publish, and manage its apps. Publish only websites you trust. See [SECURITY.md](SECURITY.md) for details.

## Publish a website

Create a ZIP with `index.html` at its root, then upload it using your TailNow address:

```sh
curl -F "file=@site.zip" https://YOUR-DEVICE.YOUR-TAILNET.ts.net/api/publish/my-app
```

Your website appears in the directory immediately. Upload to the same name to update it. TailNow hosts static HTML, CSS, and JavaScript; apps that need their own server can be added as links in the configuration’s `apps` list.

**Remove** hides an app from the directory but leaves a hosted website accessible at its full URL. **Also shut down** takes a hosted website offline while retaining its files. Shutting down a linked app requires a configured, dedicated macOS LaunchAgent.

## Try the demo

From the cloned repository, with the required Node version installed:

```sh
npm ci
npm run demo
```

Open [localhost:8081](http://localhost:8081). The demo uses temporary data and example links, resets on each launch, and leaves your private configuration untouched. Stop it with Ctrl+C.

## Development

```sh
npm test
npm audit --omit=dev
```

Keep your private storage backed up and run only one TailNow process per data directory. Previous website releases are retained, so monitor disk space. For automatic startup on macOS, adapt the [LaunchAgent example](deploy/com.example.tailnow.plist.example) to your installation.

## License

Original code and documentation by Palermo Penano are covered by the [MIT License](LICENSE). See [LICENSING.md](LICENSING.md) for third-party and user-content scope.
