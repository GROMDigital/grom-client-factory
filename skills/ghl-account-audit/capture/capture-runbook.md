# Capture Runbook

Use this runbook to capture workflow JSON from HighLevel's workflow builder internals.

## Preconditions

- The user is logged into GHL in a browser profile you can automate.
- The user has access to the target location and workflow.
- Work in a project directory where `workflow-json/` output can be saved.

## 1. Parse Target IDs

From a workflow URL:

```text
https://app.gohighlevel.com/location/{LOCATION_ID}/workflow/{WORKFLOW_ID}
```

If the URL includes query params or extra path segments, keep only the location ID and workflow ID.

## 2. Open The Parent Workflow Page

Navigate to:

```text
https://app.gohighlevel.com/location/{LOCATION_ID}/workflow/{WORKFLOW_ID}
```

Wait a few seconds for the cross-origin workflow iframe to load:

```text
https://client-app-automation-workflows.leadconnectorhq.com/location/{LOCATION_ID}/workflow/{WORKFLOW_ID}
```

## 3. Capture The Scoped JWT

Inspect network requests with request headers enabled. Filter by:

```text
workflow/{LOCATION_ID}/{first-8-chars-of-WORKFLOW_ID}
```

Use a `200` workflow response whose request headers include:

```text
authorization: Bearer eyJ...
referer: https://client-app-automation-workflows.leadconnectorhq.com/
channel: APP
version: 2021-07-28
```

Copy the `authorization` value and strip the leading `Bearer `; the `eyJ...` part is the JWT (`TOKEN`). Reject tokens from requests whose `referer` is `https://app.gohighlevel.com/`; those are not scoped for the workflow backend and usually return `401`.

> **Auth note (GHL migrated 2026-07):** the backend now authenticates via `Authorization: Bearer <JWT>`. The old `token-id` header returns `401`. If you still see requests using `token-id`, you're on stale traffic; use the `authorization` header.

If no `authorization: Bearer` header appears, ask the user to reload the workflow page or manually open the workflow in their logged-in browser, then inspect network requests again.

## 4. Switch To The Iframe Origin

Navigate the automated browser to:

```text
https://client-app-automation-workflows.leadconnectorhq.com/location/{LOCATION_ID}/workflow/{WORKFLOW_ID}
```

The page may look blank. That is fine. The origin is needed so browser `fetch()` satisfies CORS.

## 5. Throttle Before Every Fetch

Run this before each backend fetch:

```bash
python3 ~/.claude/skills/get-ghl-workflow-json/scripts/throttle.py wait --state .ghl-workflow-json-throttle.json
```

If a response returns `429` or `403`, immediately run:

```bash
python3 ~/.claude/skills/get-ghl-workflow-json/scripts/throttle.py reject 429 --state .ghl-workflow-json-throttle.json
```

Replace `429` with the actual status. Stop after this; do not retry in the same turn.

## 6. Fetch From Browser Context

Use this browser-evaluate shape, substituting `URL` and `TOKEN`:

```javascript
async () => {
  const res = await fetch(URL, {
    method: "GET",
    headers: {
      "authorization": "Bearer " + TOKEN,
      "channel": "APP",
      "source": "WEB_USER",
      "version": "2021-07-28",
      "accept": "application/json, text/plain, */*"
    }
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return {
    status: res.status,
    ok: res.ok,
    url: res.url,
    body
  };
}
```

Save `body` as the raw endpoint JSON when `ok` is true. Save the wrapper only for failed responses so the status and error body are preserved.

## 7. Endpoint Menu

Base URL:

```text
https://backend.leadconnectorhq.com
```

Fetch these by default:

| File | Endpoint |
|---|---|
| `workflow.json` | `/workflow/{LOCATION_ID}/{WORKFLOW_ID}?includeScheduledPauseInfo=true` |
| `trigger.json` | `/workflow/{LOCATION_ID}/trigger?workflowId={WORKFLOW_ID}` |

Fetch these when requested or useful:

| File | Endpoint |
|---|---|
| `sticky-notes.json` | `/workflows/sticky-notes-all?workflowId={WORKFLOW_ID}&locationId={LOCATION_ID}` |
| `step-counts.json` | `/workflows/status/search/count-per-step?workflowId={WORKFLOW_ID}&locationId={LOCATION_ID}` |
| `trigger-catalog.json` | `/marketplace/core/search/module?locationId={LOCATION_ID}&type=triggers&isInstalled=true&skip=0&limit=200` |
| `action-catalog.json` | `/marketplace/core/search/module?locationId={LOCATION_ID}&type=actions&isInstalled=true&skip=0&limit=200` |
| `pipelines.json` | `/opportunities/pipelines?locationId={LOCATION_ID}` |
| `custom-values.json` | `/custom-data/conversations?locationId={LOCATION_ID}&types=custom-values` |
| `workflow-settings.json` | `/workflow/{LOCATION_ID}/workflow-location-setting/settings` |

## 8. Save Manifest

Create `manifest.json` next to the captured JSON:

```json
{
  "sourceUrl": "https://app.gohighlevel.com/location/LOCATION_ID/workflow/WORKFLOW_ID",
  "locationId": "LOCATION_ID",
  "workflowId": "WORKFLOW_ID",
  "capturedAt": "YYYY-MM-DDTHH:mm:ssZ",
  "files": [
    {"purpose": "workflow", "path": "workflow.json", "status": 200},
    {"purpose": "trigger", "path": "trigger.json", "status": 200}
  ],
  "skipped": []
}
```

## 9. Validate

Run:

```bash
python3 ~/.claude/skills/get-ghl-workflow-json/scripts/validate_workflow_capture.py workflow-json/{LOCATION_ID}/{WORKFLOW_ID}/{YYYY-MM-DD-HHMM}
```

Report validation warnings plainly. Do not pretend a partial capture is complete.

## 10. Expiry And Re-Capture

The iframe JWT usually expires around one hour after issue. If a fetch returns `401`, reload the workflow in the parent GHL app, capture a fresh iframe `Authorization: Bearer` JWT, and continue only after that succeeds.
