# Gradual Deployer

A Cloudflare Worker that uses [Workflows](https://developers.cloudflare.com/workflows/) to orchestrate gradual (percentage-based) deployments of other Workers, with automatic health checks and rollback.

## How it works

1. You upload a new version of your target Worker with `wrangler versions upload` (does **not** deploy it).
2. You send a POST request to this deployer with the script name and version ID.
3. A durable Workflow steps through increasing traffic percentages (e.g. 10% → 25% → 50% → 75% → 100%).
4. Between each step, health is polled every 15 seconds using the Cloudflare GraphQL Analytics API.
5. If the error rate exceeds the threshold at any check, the Workflow immediately rolls back to the previous version at 100%.

```
fetch-current-deployment
  │
  ▼
deploy-at-10%  ──►  [15s sleep → health check] × N  ──►  deploy-at-25%  ──► ...
                         │                                    │
                    FAIL ▼                               FAIL ▼
                     rollback                             rollback
                         │
                    return "rolled_back"
```

Each sleep and health check is a **durable Workflow step** — if the Worker restarts, it resumes from the last completed step rather than starting over.

## Setup

### 1. Install dependencies

```bash
cd deployer
npm install
```

### 2. Configure secrets

The deployer needs a Cloudflare API token and your account ID to call the deployments and analytics APIs:

```bash
npx wrangler secret put CF_API_TOKEN
# Paste your API token (needs Workers Scripts:Edit and Analytics:Read permissions)

npx wrangler secret put ACCOUNT_ID
# Paste your Cloudflare account ID
```

### 3. Deploy the deployer

```bash
npx wrangler deploy
```

## Usage

### Start a gradual deployment

First, upload a new version of your target Worker without deploying it:

```bash
cd ../packages
npx wrangler versions upload
# Output includes the version ID, e.g. dc8dcd28-271b-4367-9840-6c244f84cb40
```

Then trigger the gradual rollout:

```bash
curl -X POST https://gradual-deployer.<subdomain>.workers.dev/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "scriptName": "my-worker",
    "newVersionId": "dc8dcd28-271b-4367-9840-6c244f84cb40"
  }'
```

### Check deployment status

```bash
curl https://gradual-deployer.<subdomain>.workers.dev/status/<instanceId>
```

### View API documentation

```bash
curl https://gradual-deployer.<subdomain>.workers.dev/
```

## Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `scriptName` | string | Yes | — | Name of the target Worker to deploy |
| `newVersionId` | string | Yes | — | Version ID from `wrangler versions upload` |
| `steps` | number[] | No | `[10, 25, 50, 75, 100]` | Traffic percentage steps to progress through |
| `waitMinutes` | number | No | `5` | Minutes to observe at each percentage step |
| `errorThreshold` | number | No | `5` | Max error rate (%) before triggering rollback |

### Example with custom parameters

```bash
curl -X POST https://gradual-deployer.<subdomain>.workers.dev/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "scriptName": "my-worker",
    "newVersionId": "dc8dcd28-...",
    "steps": [5, 10, 25, 50, 100],
    "waitMinutes": 10,
    "errorThreshold": 2
  }'
```

## Health checks

Health is evaluated by querying the `workersInvocationsAdaptive` dataset in the Cloudflare GraphQL Analytics API, filtered by `scriptVersion`. The query groups results by invocation `status`:

- **Healthy:** `success`, `clientDisconnected`
- **Error:** `scriptThrewException`, `exceededResources`, `internalError`

The error rate is calculated as `errors / total_requests * 100`. If it exceeds `errorThreshold` at any 15-second check, the Workflow rolls back immediately.

**Note:** A Worker that returns an HTTP 500 via `new Response("error", { status: 500 })` is considered a successful invocation by the Workers runtime. To be detected by the health check, the Worker must `throw` an uncaught exception.

## Configuration

Default values are set in `wrangler.toml` as environment variables and can be overridden per-environment:

```toml
[vars]
ERROR_THRESHOLD = "5"        # default max error rate %
DEFAULT_WAIT_MINUTES = "5"   # default observation window per step
```

## Project structure

```
deployer/
├── wrangler.toml          # Worker + Workflow binding configuration
├── package.json
└── src/
    ├── index.ts           # HTTP handler (POST /deploy, GET /status/:id)
    └── workflow.ts         # GradualDeployWorkflow class
```
