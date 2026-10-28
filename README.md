# expendial

Personal expense and subscription ledger. A single page (`public/index.html`) served by a tiny Bun server (`server.ts`) that keeps the ledger in `data/state.json`.

```sh
docker compose up -d --build   # start (restarts automatically with Docker)
docker compose logs -f         # logs
docker compose down            # stop
```

Open http://localhost:8787. Back up by copying `data/state.json`.

If your network needs a proxy to reach the internet, put it in `.env` as `PROXY=http://127.0.0.1:10808`. The container shares the host's network so it can reach a proxy on the host's localhost; leave `PROXY` out to connect directly.

The server fetches exchange rates once a day from open.er-api.com and keeps each day's rates, so past entries convert at the rates of their own day. Turn it off in Preferences to type rates by hand.

Without Docker: `bun server.ts` (port 3000, data in `./data`).
