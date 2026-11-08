# Template files

A template made outside the code. Upload it in **Admin → Template library**. Nothing is deployed: the
server checks the file, keeps it, and every field (or academy) has it in its Creative hub under
**Templates → My templates → New from Replay**.

`field-special-offer.json` is an example: a day's prices (up to three rows), recording and stats included.

## Ways to make one

1. **From a built-in.** In Admin → Template library, pick it under "Start from a built-in" and download
   the file. Change the layers, give it a new `key`, and upload it.
2. **From the editor.** Design it in the Creative hub, save it as one of My templates, and download it
   from the library page once an admin has uploaded it.
3. **Ask Claude.** Give it this README and `lib/api-zod/src/templateFiles.ts`, and say what the
   template should show.

## The file

```json
{
  "replayTemplate": 1,
  "key": "field-special-offer",
  "title": { "en": "Special offer", "ar": "عرض خاص" },
  "description": "optional, shown to admins",
  "audience": "field",
  "baseKey": "field-open-slots",
  "replacesBase": false,
  "clips": 3,
  "formats": { "story": { "v": 1, "format": "story", "layers": [] }, "post": { "v": 1, "format": "post", "layers": [] } },
  "sampleData": { "custom": { "title": "عرض خاص", "r1": "ساعتين", "p1": "30 دينار" } }
}
```

| Field | Meaning |
|---|---|
| `key` | Lower-case letters, digits and dashes. Uploading the same key again updates that template. |
| `audience` | `field`, `academy` or `all`: who sees it. |
| `baseKey` | Optional: a built-in the template fills like. The autopilot gives it that built-in's data. |
| `replacesBase` | `true`: use this template instead of `baseKey` everywhere, the Instagram autopilot included. A field's own "use instead" in My templates still wins. It can be switched on and off on the library page. |
| `clips` | Optional, video montages only: the number of clips the layout is made for. The template replaces the built-in only for posts with that many clips. |
| `formats` | One scene per size: `story` (1080×1920), `post` (1080×1350), `square` (1080×1080). |
| `sampleData.custom` | The words it starts with in the editor. |

Several templates can go in one file: `{ "replayTemplates": 1, "templates": [ … ] }`.

A file with any problem keeps nothing. The page lists each problem with where it is, for example
`formats.story.layers.3.size: Number must be less than or equal to 600`.

## Scenes

A scene is the Creative hub's own format: `lib/api-zod/src/creativeScene.ts`.

- Layers are listed bottom to top: `shape`, `text`, `image` and `video`.
- Positions and sizes are in real pixels on the 1080-wide canvas.
- A video scene has a `durationMs`. Each layer can have a `startMs`, an `endMs` and an `enter`
  animation (`fade`, `slide-up`, `pop`, `wipe` …).
- **Colours** are hex or the brand's tokens: `@primary`, `@ink`, `@paper`, `@on-primary`. A token
  takes each field's own colours.
- **Words** can hold bindings:
  - `{{custom.title}}`, `{{custom.field}}` (the field's name) and `{{custom.bookLine}}`;
  - `{{academy.phone}}` and `{{custom.siteLine}}`;
  - for a template replacing a built-in, the built-in's own `{{custom.*}}` words. Download the
    built-in to see them.
- **Footage and pictures:**
  - `{"type": "binding", "path": "media"}` is the clip, and `more.0`, `more.1` … are the next clips;
  - the field's crest is `{"type": "crest"}`.
- **`when`** shows a layer only when some data is there, for example `[{"path": "custom.r3"}]`
  draws the third row only when there is a third price.
