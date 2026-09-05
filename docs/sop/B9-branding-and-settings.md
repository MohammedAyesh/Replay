# B9 — Branding and settings

Written 2026-09-05. Where to set what, what wins over what, and the three places
this has quietly not worked before.

---

## 1. Settings: three layers

Admin → **Settings**.

```
a matching rule        ← conditional: this field, this academy, Friday nights
      ↓ if none
an administrator's base value   ← "this is how the product is configured"
      ↓ if none
the value shipped in the code
```

The badge on each row says which one you are looking at: **Rule #n**, **Base**,
or **Shipped**. Before the middle layer existed, changing the value everyone gets
meant writing a global rule — which worked, but put an ordinary configuration
decision into the same list as the genuinely conditional ones. That list is what
you read when something surprising is happening, and a base value is not a
surprise.

**To change the base value**: expand the setting, "Change" under *Base value,
when no rule applies*.

**To put it back**: "Reset to shipped". This deletes the stored row rather than
writing today's shipped value into it — copying would pin the key, and a later
change to the default in code would then be silently ignored for it forever.

Rules still win. Precedence among rules is priority-first, so the preview at the
top of the tab is the only reliable answer to "what does this user, at this
field, get right now".

### Which settings actually do something

As of today these are read by code: `downloads.limit`, `downloads.windowDays`,
`downloads.enabled`, `clip.maxDurationSeconds`, `render.maxConcurrent`,
`render.yieldToArchive`, `render.yieldCeilingSeconds`, `playback.maxWidth`,
`branding.overlayEnabled`, `branding.endCardEnabled`.

**Still registered and still inert**: `export.crf`, `export.preset`,
`export.fps`, `render.yieldLoadRatio`, `share.posterEnabled`, and
`clip.introEnabled`. They render, they save, they change nothing.

**`share.enabled` is worse than inert.** Its description says *"Off makes every
share page 404, including links already sent."* It is read only by
`/client-settings`, which the frontend uses to hide the Share button;
`routes/share.ts` never checks it. Turn it off to kill a link you regret and the
page keeps serving to anyone holding the URL. Do not rely on it.

---

## 2. Branding: overlay and end card

Admin → **Branding**. Pick a scope — Everyone, a field, or an academy — then
upload.

```
academy's own        ← if that academy has one
      ↓
the field's          ← if that field has one
      ↓
the global one
      ↓
nothing: the clip exports unbranded
```

Each piece resolves separately. An academy with an overlay but no end card gets
the **global** end card, deliberately: a clip carrying an academy's logo and no
sign-off is worse than one that mixes tiers. The tab shows "inherited from …"
when what you are looking at is not this scope's own.

### The overlay

A **PNG with transparency**, authored at the export size — currently
**1920×1080** landscape, **1080×1920** portrait; the tab prints the live numbers.

It is composited at 0,0 with **no scaling**, in the same encode as the clip. So
an overlay at the wrong size does not fail: it sits in a corner, or covers a
third of the frame. The tab compares the uploaded dimensions against the export
geometry and says so in amber. That is deliberate — scaling to fit would change
the mark's proportions and move it, and a logo that shifts between a 16:9 and a
9:16 export is worse than one that is missing.

**A JPEG is refused.** It has no alpha channel, so it would paint a solid
rectangle over the whole frame.

> **Check the alpha, not the preview.** `drawbox` in ffmpeg *blends* into the RGB
> planes and leaves alpha at zero. A PNG built that way looks correct in any
> viewer and composites to nothing at all. If you generate an overlay with
> ffmpeg, `replace=1` is load-bearing. To check an existing file:
> ```bash
> ffmpeg -v error -i overlay.png -vf "crop=10:10:5:5,scale=1:1" \
>   -frames:v 1 -f rawvideo -pix_fmt rgba -y /tmp/px.raw
> xxd /tmp/px.raw     # fourth byte is alpha; 00 means it will not show
> ```

### The end card

A short MP4, appended after the clip. It is normalized to the clip's exact
output spec and joined with the concat demuxer, in the same pass as the academy
intro.

### Turning it off

`branding.overlayEnabled` and `branding.endCardEnabled` in Settings, at any
scope. Both are consulted before the assets are even looked up, so off costs
nothing at render time. Both apply to **new work only** — anything already
rendering keeps what it started with.

### Branding never costs a clip

Every failure in this path — an unreachable asset, a file ffmpeg will not
decode, a concat that refuses — is logged and swallowed, and the export falls
back to the clip itself. If clips are coming out unbranded, the reason is in the
API log, not in a failed export.

---

## 3. The academy intro

Admin → **Academies**, per academy, plus a global fallback on the same tab.
Separate from the branding above and older: it is played by the web player as
well as prepended to the exported file.

> **The Academies tab had no button for a while.** It was rendered by a line in
> the content switch and missing from the label list, so it existed, worked, and
> could not be reached. The two lists are now one `Record<Tab, …>`; omitting a
> tab is a compile error.

---

## 4. Where it lives

| | |
|---|---|
| `lib/db/src/schema/settingsDefaults.ts` | Base values |
| `lib/db/src/schema/brandingAssets.ts` | Overlay and end card, one row per scope and kind |
| `artifacts/api-server/src/lib/settingsResolver.ts` | The three layers |
| `artifacts/api-server/src/lib/brandingAssets.ts` | Resolution order, geometry check, filter splice |
| `artifacts/api-server/src/routes/branding.ts` | Upload, list, remove |
| `artifacts/api-server/src/lib/ffmpegExport.ts` | `withBookends`, and the overlay in the main encode |
| `artifacts/soccerwatch/src/components/admin/BrandingTab.tsx` | The tab |

`lib/branding.ts` is the **old** disk-based lookup. Nothing calls it. It is
still in the tree with its tests; delete it when you are confident nothing wants
the `BRANDING_ROOT` layout back.

---

## 5. Schema

Both features need a push before they work:

```bash
pnpm --filter @workspace/db run push
```

`settings_defaults` and `branding_assets`. Until then the console says so in
amber rather than 500-ing, and every setting resolves to its shipped value.

**`scope_id` is 0 for global, never NULL.** Postgres treats NULLs in a unique
index as distinct from one another, so with NULL there every global upload
inserted a new row instead of replacing the previous one — and resolution then
returned whichever the query happened to hand back first. Nothing failed; the
wrong logo came out.
