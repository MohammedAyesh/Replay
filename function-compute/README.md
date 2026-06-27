# SoccerWatch – Function Compute

Serverless function for Alibaba Cloud Function Compute.
Lists video files from your `cam9` OSS bucket by camera and date,
and returns signed (time-limited) URLs.

---

## Deploy

### 1 – Install dependencies locally

```bash
cd function-compute
npm install
```

### 2 – Zip the package

```bash
zip -r deploy.zip index.js package.json node_modules/
```

### 3 – Upload to Function Compute

1. Open **Function Compute** console → your service → **Create Function**
2. Choose **HTTP Trigger**, runtime **Node.js 18**
3. Upload `deploy.zip`
4. Set handler to `index.handler`

### 4 – Set environment variables

In the function's **Configuration → Environment Variables**, add:

| Key                    | Value                  |
|------------------------|------------------------|
| `OSS_BUCKET`           | `cam9`                 |
| `OSS_REGION`           | `oss-me-central-2`     |
| `OSS_ACCESS_KEY_ID`    | your AccessKey ID      |
| `OSS_ACCESS_KEY_SECRET`| your AccessKey Secret  |

> Tip: use a RAM sub-account with **read-only** OSS permissions instead of root credentials.

---

## API

```
GET https://<your-fc-endpoint>/compute
```

| Query param | Default        | Description                           |
|-------------|----------------|---------------------------------------|
| `camera`    | `Cam01`        | Camera folder name (e.g. `Cam01`)     |
| `date`      | today (UTC+3)  | ISO date `YYYY-MM-DD`                 |

### Response

```json
{
  "camera": "Cam01",
  "date": "2026-06-27",
  "cameras": ["Cam01", "Cam02"],
  "videos": [
    {
      "key": "Cam01/2026/2026-06-27/goal_32min.mp4",
      "url": "https://cam9.oss-me-central-2.aliyuncs.com/...?Signature=...",
      "filename": "goal_32min.mp4"
    }
  ],
  "fieldImageUrl": "https://cam9.oss-me-central-2.aliyuncs.com/Cam01/field.png?Signature=..."
}
```

- `videos[].url` — signed, valid for **1 hour**
- `fieldImageUrl` — signed, valid for **24 hours** (used as the field cover image)

---

## OSS folder structure expected

```
cam9/
  Cam01/
    field.png          ← cover image for this camera's field
    2025/
      2025-MM-DD/      ← any path containing the ISO date works
        video.mp4
    2026/
      2026-MM-DD/
        video.mp4
  Cam02/
    field.png
    2026/
      ...
```
