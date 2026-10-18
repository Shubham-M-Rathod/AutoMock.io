# AutoMock — Kestra Project

> **Auto-generates frontend mock data when the backend `openapi.yml` changes. Helps frontend devs stay in sync early — without blocking them.**

---

## How It Works

```
Backend push (openapi.yml changed)
        │
        ▼
[Kestra Flow 1] detect-and-generate
        │  compares SHA → generates mocks
        │
        ├──► Opens a Draft PR in frontend repo with updated mocks
        └──► Notifies frontend repo owner via GitHub Issue
        
Frontend dev opens a PR
        │
        ▼
[Kestra Flow 2] check-frontend-pr
        │  validates mocks vs. current openapi SHA
        │
        ├──► Sets informational GitHub Status badge on PR
        └──► Posts helpful comment if mocks look outdated (non-blocking)
```

---

## Project Structure

```
kestra/
├── docker-compose.yml          ← Kestra + Postgres
├── flows/
│   ├── 1-detect-and-generate.yml   ← Flow 1: backend push → generate → PR
│   └── 2-check-frontend-pr.yml     ← Flow 2: frontend PR → validate → status
└── scripts/
    └── generate-mocks.mjs          ← Node.js mock generator (OpenAPI → JSON fixtures + MSW)
```

---

## Setup

### 1. Start Kestra
```bash
docker-compose up -d
# UI at http://localhost:8080
```

### 2. Add Secrets in Kestra UI
Go to **Namespaces → automock → Secrets** and add:

| Key | Value |
|-----|-------|
| `GITHUB_TOKEN` | GitHub PAT with `repo` + `pull_requests` + `statuses` scope |
| `FRONTEND_REPO_OWNER_GITHUB_USERNAME` | GitHub username of the frontend repo owner |

### 3. Upload Flows
In the Kestra UI → **Flows → Import**, upload both YAML files from `flows/`.

Or via the API:
```bash
# Flow 1
curl -X POST http://localhost:8080/api/v1/flows \
  -H "Content-Type: application/x-yaml" \
  --data-binary @flows/1-detect-and-generate.yml

# Flow 2
curl -X POST http://localhost:8080/api/v1/flows \
  -H "Content-Type: application/x-yaml" \
  --data-binary @flows/2-check-frontend-pr.yml
```

### 4. Configure GitHub Webhooks

**Backend repo** → Settings → Webhooks → Add webhook:
- Payload URL: `http://<your-server>:8080/api/v1/executions/webhook/automock/automock-detect-and-generate/backend-push`
- Content type: `application/json`
- Events: ✅ **Pushes**

**Frontend repo** → Settings → Webhooks → Add webhook:
- Payload URL: `http://<your-server>:8080/api/v1/executions/webhook/automock/automock-check-frontend-pr/frontend-pr`
- Content type: `application/json`
- Events: ✅ **Pull requests**

> For local dev, use [ngrok](https://ngrok.com) to expose `localhost:8080`:
> ```bash
> ngrok http 8080
> ```

### 5. Update Repo Variables in the Flows
Edit both flow YAML files and replace:
```yaml
variables:
  backend_repo_owner: "your-org"   # ← your GitHub org or username
  backend_repo_name: "backend"      # ← your backend repo name
  frontend_repo_owner: "your-org"  # ← your GitHub org or username
  frontend_repo_name: "frontend"    # ← your frontend repo name
```

---

## What the Frontend Gets

When `openapi.yml` changes, a Draft PR is opened in the frontend repo with:

```
src/__mocks__/
  .automock-meta.json          ← sync metadata (used by Flow 2)
  endpoints/
    users/
      GET/
        200.json               ← mock GET /users response
        404.json               ← mock error response
      POST/
        201.json
    products/
      GET/
        200.json
  msw-handlers.js              ← plug-and-play MSW v2 handlers
```

**Using the MSW handlers in your tests:**
```js
// src/mocks/browser.js
import { setupWorker } from 'msw/browser';
import { handlers } from '../__mocks__/msw-handlers.js';
export const worker = setupWorker(...handlers);
```

---

## Philosophy

- ✅ **Inform early** — devs get notified as soon as the backend changes, not when it's already in production
- ✅ **Auto-generate** — no one has to remember to update mocks manually
- ✅ **Non-blocking** — it's a Draft PR + status badge, never a hard gate
- ✅ **Owner-targeted** — only the frontend repo owner gets the notification, not everyone

---

## Roadmap Ideas

- [ ] Slack notification to owner (via Kestra HTTP task → Slack webhook)
- [ ] Email notification via Kestra SMTP plugin
- [ ] Diff summary in PR description (which endpoints added/removed/changed)
- [ ] Only flag breaking changes (use `openapi-diff` in the validate step)
- [ ] Auto-close the notification issue when the mock PR is merged
- [ ] `npm run generate:mocks` script for local re-generation

