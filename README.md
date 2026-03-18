# Tailnow (Self-Hosted Agent Hosting)

A private, self-hosted static site publisher built specifically for your Tailscale network.

## The Goal
Instead of deploying to public cloud services (like Vercel, Netlify, or `here.now`), **Tailnow** runs a tiny API server on your machine that allows any AI agent on your Tailnet to instantly deploy static sites directly to your local file system using a single `curl` command.

---

## 1. Setup the Host Server

Clone this repository to the machine that will host your sites (e.g., your home server or Mac Mini).

```bash
# Install dependencies
npm install

# Start the server (runs on port 8080)
npm start
```

Open a new terminal tab and expose the server to your Tailnet securely:
```bash
tailscale serve --bg 8080
```
*Note: Make sure your Tailnet name/IP is ready. For example, `https://selenes-mac-mini.tailb06eed.ts.net/`*

---

## 2. Deploying from Any Agent (No Installs Required)

On your laptop, desktop, or cloud IDE, you don't need to install any client scripts. Since AI agents (Claude Code, Cursor, OpenClaw) already know how to use `zip` and `curl`, you just give them the endpoint.

**Prompt your agent with this:**
> "Build the app into the `dist` folder. Zip the `dist` folder and `curl` it to `https://selenes-mac-mini.tailb06eed.ts.net/api/publish/my-app`"

**What the agent runs automatically:**
```bash
cd dist && \
zip -r -q site.zip . && \
curl -F "file=@site.zip" https://selenes-mac-mini.tailb06eed.ts.net/api/publish/my-app && \
rm site.zip
```

The server instantly receives the payload, extracts it into the `sites/my-app/` folder, and serves the site. It immediately goes live at:  
👉 **`https://selenes-mac-mini.tailb06eed.ts.net/my-app/`**

---

## 3. Security Architecture

Because Tailnow is designed to sit behind Tailscale, the heavy lifting of authentication is handled at the network level. However, the application itself implements several critical security layers to ensure the host machine remains safe:

1. **Network Auth:** Tailnow is completely invisible to the public internet. If a device is not authenticated on your specific Tailnet, the request is dropped before it reaches the Node.js server.
2. **Directory Traversal Protection:** The project name parameter is strictly validated using Regex (`^[a-zA-Z0-9_-]+$`). This prevents attackers from passing paths like `../../etc` to overwrite system directories.
3. **Zip Slip Protection:** Before extraction, the server inspects the name of every file inside the `.zip` archive. If any file attempts to navigate up the directory tree (`../`), the extraction is aborted, and the payload is destroyed.
4. **Denial of Service (DoS) Prevention:** The `multer` upload handler strictly caps incoming payloads at **100 MB** to prevent disk exhaustion attacks.
