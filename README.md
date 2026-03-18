# Tailnow (Self-Hosted Agent Hosting)

A private, self-hosted static site publisher for your Tailscale network. 

## Features
- **Zero Client Scripts:** No scripts to download or install on your other machines. Agents use standard `zip` and `curl`.
- **Private:** Completely invisible to the public internet. Only devices on your Tailnet can access it.
- **Cross-Agent:** Works seamlessly with Claude Code, OpenClaw, Cursor, or any other agent.

---

## 1. Start the Server (Host Machine)

Clone this repository to the machine that will host your sites (e.g., your Mac Mini).

```bash
npm install
npm start
```

Then, open a new terminal tab and expose the server to your Tailnet:
```bash
# Assuming the server is running on port 8080
tailscale serve --bg 8080
```

---

## 2. Deploy from Any Agent (No Setup Required)

On your laptop (or any other machine), you don't need to install anything. Since AI agents already know how to use `zip` and `curl`, you just give them the endpoint.

Tell your agent:
> "Build the app, zip the output folder, and curl it to `http://selenes-mac-mini:8080/api/publish/my-app`"

**The standard command the agent will run:**
```bash
cd dist && zip -r -q site.zip . && curl -F "file=@site.zip" http://selenes-mac-mini:8080/api/publish/my-app && rm site.zip
```

The server instantly unzips the payload and serves it. Your site immediately goes live at:
`http://selenes-mac-mini/my-app/`