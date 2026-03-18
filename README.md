# Tailnow (Self-Hosted Agent Hosting)

A private, self-hosted version of an instant static-site publisher (like `here.now`) built specifically for your Tailscale network. 

## Features
- **Private:** Completely invisible to the public internet. Only devices authenticated on your Tailnet can see or publish sites.
- **Cross-Agent:** Works seamlessly with Claude Code, OpenClaw, Cursor, or any other agent that can run a bash script.
- **Zero Config:** Uses `tailscale serve` to instantly bind the port and handle SSL/auth.

---

## 1. Setting up the Server (Host Machine)

Clone this repository to the machine that will host your sites (e.g., your Mac Mini).

```bash
cd tailnow
npm install
npm start
```

Then, open a new terminal tab and expose the server to your Tailnet:
```bash
# Assuming the server is running on port 8080
tailscale serve --bg 8080
```

---

## 2. Using the Client (Your Laptop / Agents)

On any *other* computer connected to your Tailnet (like your laptop running Claude Code), download the `publish.sh` script. 

When you ask your agent to build a static site, give it these instructions:
1. "Build the app into a folder (like `./dist` or `./public`)."
2. "Run `./publish.sh <tailscale-machine-name> <project-name> <folder>`"

### Example Usage

```bash
chmod +x publish.sh

# Deploy the "snake-game" folder to your Tailscale server
./publish.sh http://selenes-mac-mini snake-game ./snake-game
```

The script will zip the folder, push it securely across your Tailnet to the server, and extract it instantly. Your site will immediately be live at:
`http://selenes-mac-mini/snake-game/`