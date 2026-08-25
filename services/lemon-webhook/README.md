# Macnu license webhook

This directory contains the Cloudflare Worker that synchronizes Macnu license
limits with Lemon Squeezy orders.

## Behavior

The Worker:

- accepts Lemon Squeezy events at `POST /webhooks/lemon-squeezy`
- verifies the raw request body with HMAC-SHA256
- limits request and upstream response sizes
- verifies live license, order-item, order, product, and variant data
- derives Business activation limits from purchased seat quantity
- handles repeat deliveries idempotently
- disables matching licenses after a verified full refund
- ignores test-mode, unrelated-product, and unknown-variant events
- never logs request bodies, license keys, customer names, or customer email
  addresses

`GET /healthz` is the unauthenticated health endpoint.

## Local verification

```sh
npm ci
npm run check
npm run dry-run
```

For local development, create an ignored `.dev.vars` file with test-only
credentials:

```dotenv
LEMON_WEBHOOK_SECRET="local-test-secret"
LEMON_API_KEY="test-mode-api-key"
```

Never commit `.dev.vars`, production credentials, webhook payloads, or customer
data.

## Forks and self-hosting

No Lemon Squeezy or Cloudflare credential is included in this repository.
Anyone deploying a fork must use their own store, product, variants, API key,
webhook secret, and Worker account. Product-specific identifiers live in
`src/constants.ts` and must be replaced for a fork.

Store deployed credentials as encrypted platform secrets. Keep production
configuration outside source control and run the tests before deployment.
