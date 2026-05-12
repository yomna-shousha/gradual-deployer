# Gradual Deployer

Safe, automated gradual deployments for Cloudflare Workers. Upload a new version, and this deployer will roll it out step-by-step while monitoring [Workers Observability](https://developers.cloudflare.com/workers/observability/) for errors. If anything goes wrong, it rolls back instantly (~5s).

Built on [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) — every step is durable. If the deployer restarts mid-rollout, it picks up where it left off.

## Quick start

### 1. Deploy the gradual-deployer to your account

```sh
git clone https://github.com/yomna-shousha/gradual-deployer.git
cd gradual-deployer
npm install

# Set your secrets
npx wrangler secret put CF_API_TOKEN    # needs Workers Scripts:Edit + Account Analytics:Read
npx wrangler secret put ACCOUNT_ID      # your Cloudflare account ID

# Deploy
npx wrangler deploy
```

### 2. Make sure your target Worker has observability enabled

In your target Worker's `wrangler.jsonc` (or `wrangler.toml`):

```jsonc
{
  "observability": {
    "enabled": true,
    "logs": { "invocation_logs": true }
  }
}
```

Redeploy your target Worker if you just added this.

### 3. Gradually deploy a new version

```sh
# Step 1: Upload a new version of your Worker (does NOT deploy it)
cd your-worker
npx wrangler versions upload
# → outputs: Worker Version ID: dc8dcd28-271b-4367-9840-6c244f84cb40

# Step 2: Tell the deployer to roll it out
curl -X POST https://gradual-deployer.<your-subdomain>.workers.dev/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "scriptName": "your-worker-name",
    "newVersionId": "dc8dcd28-271b-4367-9840-6c244f84cb40"
  }'

# Step 3: Check status anytime
curl https://gradual-deployer.<your-subdomain>.workers.dev/status/<instanceId>
```

That's it. The deployer will roll out 10% → 25% → 50% → 75% → 100%, soaking for 5 minutes at each step and watching for errors. If the error rate goes above 5%, it rolls back to the previous stable version.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `scriptName` | Yes | — | Which Worker to deploy (the `name` in its wrangler config) |
| `newVersionId` | Yes | — | The version ID from `wrangler versions upload` |
| `steps` | No | `[10, 25, 50, 75, 100]` | Traffic percentages to step through |
| `soakMinutes` | No | `5` | How long to watch metrics at each step before progressing |
| `errorThreshold` | No | `5` | Error rate % that triggers a rollback |
| `healthCheckStrategy` | No | `"wobs_query"` | `"wobs_query"` or `"wobs_alerts"` (see below) |
| `smokeTestUrls` | No | `[]` | URLs to probe at 0% traffic before starting rollout |

Example with all options:

```jsonc
{
  "scriptName": "my-api",
  "newVersionId": "dc8dcd28-271b-4367-9840-6c244f84cb40",
  "steps": [5, 10, 25, 50, 100],
  "soakMinutes": 10,
  "errorThreshold": 2,
  "healthCheckStrategy": "wobs_query",
  "smokeTestUrls": ["https://my-api.example.com/health"]
}
```

## What happens when you trigger a deploy

```
1. Finds the current stable version of your Worker
2. (If smokeTestUrls provided) Deploys new version at 0% traffic,
   hits each URL with the version override header — if any fail, rolls back immediately
3. Shifts traffic to 10% → soaks for 5 min → checks Workers Observability
4. If error rate OK → shifts to 25% → soaks → checks
5. Keeps going: 50% → 75% → 100%
6. At ANY step, if error rate > threshold → instant rollback to stable version
7. Reaches 100% → done
```

## What the health checks measure

During each soak period, the deployer queries [Workers Observability](https://developers.cloudflare.com/workers/observability/) every 15 seconds to compute the error rate **for the new version only** (filtered by `$workers.scriptVersion`).

What counts as an error: any invocation where `$workers.outcome` is not `"ok"`. This includes:
- **`exception`** — your Worker threw an uncaught error
- **`exceededCpu`** — hit the CPU time limit
- **`exceededMemory`** — hit the memory limit
- **`canceled`** — request was canceled
- Any other non-`ok` outcome

What does NOT count as an error: a Worker that returns `new Response("error", { status: 500 })` — that's a successful invocation that chose to return a 500. The Workers runtime considers it `ok`. To be caught by the health check, the Worker must `throw`.

### What you need to enable on your target Worker

Just this in your target Worker's config — no SDK, no code changes:

```jsonc
// wrangler.jsonc
{
  "observability": {
    "enabled": true,
    "logs": {
      "invocation_logs": true,
      "head_sampling_rate": 1  // optional, default 1 — set lower for very high traffic
    }
  }
}
```

This gives the deployer everything it needs. It also gives you:
- **Workers Observability dashboard** at [dash.cloudflare.com → Observability](https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability/) — see all logs, filter by version, build queries
- **7-day log retention** — all invocation logs stored and queryable
- **Query Builder** — write structured queries to investigate errors, latency, traffic patterns
- You can also set up [Workers Observability alerts](https://developers.cloudflare.com/notifications/) in the Cloudflare dashboard to get notified via email/webhook/PagerDuty when errors spike

## Deploying multiple Workers

One deployer handles all your Workers. Each deploy runs as an independent Workflow instance:

```sh
# Deploy your marketing site
curl -X POST https://gradual-deployer.<you>.workers.dev/deploy \
  -H "Content-Type: application/json" \
  -d '{"scriptName": "marketing-site", "newVersionId": "aaa..."}'

# Deploy your API at the same time — completely independent
curl -X POST https://gradual-deployer.<you>.workers.dev/deploy \
  -H "Content-Type: application/json" \
  -d '{"scriptName": "api-worker", "newVersionId": "bbb...", "soakMinutes": 10}'

# Each has its own status
curl https://gradual-deployer.<you>.workers.dev/status/<marketing-instance-id>
curl https://gradual-deployer.<you>.workers.dev/status/<api-instance-id>
```

A rollback on one Worker does not affect the others.

## Smoke testing with `smokeTestUrls`

If you pass `smokeTestUrls`, the deployer validates the new version **before any real user sees it**:

1. The deployer creates a deployment with the new version at **0% traffic** — it exists but gets zero real requests
2. Sends requests to each URL with the [`Cloudflare-Workers-Version-Overrides`](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/version-overrides/) header to target the new version directly
3. If all return 2xx/3xx → proceeds to the gradual rollout steps
4. If any fail → rolls back, no real traffic ever touched the new version

## Using the version override header on its own

The [`Cloudflare-Workers-Version-Overrides`](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/version-overrides/) header is a separate Cloudflare feature — you can use it independently of this tool. It lets you send a single request to a specific version of your Worker:

```sh
curl https://your-worker.example.com/health \
  -H 'Cloudflare-Workers-Version-Overrides: your-worker-name="dc8dcd28-..."'
```

Important things to know:
- **It's per-request only.** It does not change the traffic split. If you're mid-rollout at 50/50, sending this header routes that one request to the version you specified — everyone else still gets the 50/50 split.
- **The version must be in the current deployment.** Even at 0%. If the version isn't part of the active deployment, the header is ignored.
- **It never mutates deployment state.** It's purely for testing/probing. Only the deployer (or `wrangler versions deploy`) changes traffic percentages.

## Health check strategies

| Strategy | What it does | When to use |
|---|---|---|
| `wobs_query` (default) | Queries the [Workers Observability telemetry API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/). Filters by `$workers.scriptVersion`, counts invocations where `$workers.outcome != "ok"`, computes error rate. | Most cases. Direct, precise, version-scoped. |
| `wobs_alerts` | Checks [Cloudflare Notification](https://developers.cloudflare.com/notifications/) alert history for `workers_observability_alert` fires on your script. | When you have existing alert policies set up and want the platform to evaluate health. |

## Automate with GitHub Actions

To trigger gradual deploys automatically when a PR merges:

### 1. Add `rollout.json` to your Worker's repo

```json
{
  "gradual_branches": ["release/*", "gradual-*"],
  "steps": [10, 25, 50, 75, 100],
  "soakMinutes": 5,
  "errorThreshold": 5,
  "healthCheckStrategy": "wobs_query",
  "smokeTestUrls": ["https://your-worker.example.com/health"]
}
```

`gradual_branches` controls which branches get gradual rollout. PRs from other branches deploy normally.

### 2. Copy the GitHub Actions workflow

Copy [`examples/gradual-deploy.yml`](./examples/gradual-deploy.yml) to `.github/workflows/gradual-deploy.yml` in your Worker's repo.

### 3. Set GitHub repo secrets

| Secret | Value |
|---|---|
| `CF_API_TOKEN` | Your Cloudflare API token |
| `CF_ACCOUNT_ID` | Your Cloudflare account ID |
| `DEPLOYER_URL` | `https://gradual-deployer.<your-subdomain>.workers.dev` |

### How it works

When a PR from a matching branch (e.g. `release/v2`) merges to `main`:

1. GitHub Actions builds your Worker and runs `wrangler versions upload`
2. Reads `rollout.json` for your config
3. POSTs to the deployer with the version ID and config
4. The deployer runs the gradual rollout as a durable Workflow (takes ~25 min with default settings)
5. If anything goes wrong, it rolls back automatically

The GitHub Actions job itself is fast (~30s) — it just uploads and triggers. The actual rollout runs on Cloudflare as a durable Workflow.

## Project structure

```
gradual-deployer/
├── wrangler.jsonc          # Deployer Worker + Workflow config
├── package.json
├── examples/
│   ├── gradual-deploy.yml  # GitHub Actions workflow (copy to your repo)
│   └── rollout.json        # Example rollout config (copy to your repo)
└── src/
    ├── api.ts              # Cloudflare API client
    ├── health.ts           # Health check strategies (wobs_query, wobs_alerts)
    ├── index.ts            # HTTP API (POST /deploy, GET /status/:id)
    └── workflow.ts         # Durable Workflow — the rollout logic
```
