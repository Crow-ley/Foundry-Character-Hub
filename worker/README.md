# Character Hub Worker

A Cloudflare Worker with a D1 database. It holds character snapshots and change requests so home worlds and the hub world can exchange them, since Foundry worlds cannot talk to each other directly.

No runtime dependencies. `wrangler` is only used for local testing and deploying.

## Local testing

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

In a second terminal, with the dev server running:

```bash
npm test
npm run test:endpoints
```

## Layout

- `src/index.js`: routing and CORS
- `src/auth.js`: world keys, the admin key, and the optional read-only portal key (`PORTAL_KEY` secret, for a website that shows players their characters; leave it unset if you don't have one)
- `src/db.js`: turns database errors (including daily limits) into clear responses
- `src/routes/`: the endpoints
- `migrations/`: the D1 database schema
- `test/`: unit tests and an endpoint test script
