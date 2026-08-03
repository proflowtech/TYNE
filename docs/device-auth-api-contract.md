# Device Auth API Contract (live dogfood)

> Extension dogfood talks to **live** `device-auth-start` / `device-auth-poll` when
> `tyne.deviceAuthDogfood=true` (opt-in) and `tyne.deviceAuthMode=live` (default).
> Set mode to `mock` only for offline UI work.

## Config swap point (extension)

Single place: `getDeviceAuthConfig()` in `src/deviceAuth.ts`.

| Setting | Default | Notes |
|---|---|---|
| `tyne.deviceAuthDogfood` | `false` | Opt-in gate; GitHub Device Flow unchanged when false |
| `tyne.deviceAuthMode` | `live` | Hits deployed edge functions |
| `tyne.deviceAuthMockScenario` | `auto_approve` | Mock only |
| `baseUrl` | `https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1` | |
| `startPath` | `/device-auth-start` | |
| `pollPath` | `/device-auth-poll` | |

## SecretStorage

| Key | Purpose |
|---|---|
| `tyne_session_access_token` | Supabase session access JWT |
| `tyne_session_refresh_token` | Supabase refresh token |

**Not used by device-auth:** `tyne_github_token` (legacy GitHub path; still works when dogfood off).

---

## 1. `POST /device-auth-start`

### Request

```http
POST /functions/v1/device-auth-start
Content-Type: application/json
apikey: <anon>
Authorization: Bearer <anon>

{}
```

### Success `200`

```json
{
  "device_code": "string",
  "user_code": "TYNE-XXXX-XXXX",
  "verification_uri": "https://tyne.proflowtech.io/device",
  "expires_in": 900,
  "interval": 5
}
```

`verification_uri_complete` is optional (not currently returned by live start).

---

## 2. `POST /device-auth-poll`

### Request

```json
{ "device_code": "<from start>" }
```

### Pending

```json
{
  "error": "authorization_pending",
  "status": "authorization_pending",
  "error_description": "Authorization is pending"
}
```

(HTTP 400)

### Expired

```json
{ "error": "expired_token", "error_description": "…" }
```

### Denied

```json
{ "error": "access_denied", "error_description": "…" }
```

(HTTP 403 when row status is `denied`)

### Approved

```json
{
  "status": "approved",
  "access_token": "…",
  "refresh_token": "…",
  "expires_in": 3600,
  "token_type": "Bearer",
  "user": {
    "id": "uuid",
    "tier": "CORE|MAX|…",
    "credits": 100,
    "email": "…",
    "githubUsername": "…",
    "is_banned": false
  }
}
```

---

## 3. Approve page (web)

`https://tyne.proflowtech.io/device` — logged-in user confirms `user_code`.
Calls `device-auth-approve` (JWT required). Extension only polls.

---

## Tier / credits / ban (live session)

After login, extension `_fetchUserProfile` uses `getEffectiveAuthToken` → `POST /usage` `{ action: "check" }` when `tyne_session_access_token` is present. Response includes `tier`, `credits`, `is_banned` from `user_profiles` (not login-time cache). Profile refresh runs at least every 60s when `_updateProfile` is invoked.

---

## Telemetry (client)

`globalState` key `tyne.deviceAuth.funnel` + OutputChannel `Tyne: Device Auth`:

`device_auth_flow_started` | `browser_opened` | `waiting` | `success` | `expired` | `denied` | `error` | `focus_lost` | `focus_regained`

Correlate with `device_auth_requests` row counts server-side.
