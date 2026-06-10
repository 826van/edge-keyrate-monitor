# Key Rate Monitor

Edge/Chrome Manifest V3 extension for checking relay key group rates.

## What it does

- Checks multiple relay dashboards.
- Reuses your existing browser login.
- Supports two request modes:
  - `Logged-in tab`: runs fetch inside an already logged-in site tab. This is best for dashboards that require page cookies, localStorage tokens, or same-origin requests.
  - `Extension background`: runs fetch from the extension service worker.
- Keeps config and results in local browser storage.
- Masks key-like values in response previews.

## Install in Edge

1. Open `edge://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `E:\edge-keyrate-monitor`.

After edits, click `Reload` on the extension card.

## Configure vip.lcodex.cn

1. Open `https://vip.lcodex.cn` in Edge and log in.
2. Keep that tab open.
3. Open the extension options.
4. Add a site with:
   - Name: `vip.lcodex`
   - Login origin: `https://vip.lcodex.cn`
   - Check URL: `https://vip.lcodex.cn/api/user/self/groups`
   - Request mode: `Logged-in tab`
   - Method: `GET`
   - Parser: `JSON`
   - JSON list path: leave blank first, so the extension tries auto-detection.
5. Save and check.

If the API still fails, open DevTools -> Network on the dashboard, click the same request, and inspect request headers:

- If it uses `Authorization: Bearer xxx`, find where the token is stored in Application -> Local Storage or Session Storage.
- In the extension options, set:
  - Token source: `localStorage` or `sessionStorage`
  - Token key: the storage key
  - Token JSON path: only needed if the storage value is JSON
  - Auth header: `Authorization`
  - Auth template: `Bearer {{token}}`

## JSON parsing

If the API returns:

```json
{
  "data": {
    "groups": [
      { "name": "default", "rate": 1 },
      { "name": "vip", "rate": 0.5 }
    ]
  }
}
```

Use:

- JSON list path: `data.groups`
- Group field: `name`
- Rate field: `rate`

If the list path is empty, the extension tries common paths such as `data.groups`, `data`, `groups`, and `list`.
