# Project Context Brief — grzzly Illustration Pipeline
_Last updated: March 2026. Written for Claude handoff._

---

## Who I am

MW (Mong), founder of grzzly (grzz.ly), a digital growth consultancy based in Bangkok. I handle technical implementation personally. This project is part of an auto-blogging pipeline built on Astro + Cloudflare Pages.

---

## What we have built

### 1. Auto-blog illustration pipeline (`illustrate.py`)

A Python script that generates editorial illustrations for blog posts and uploads them to Cloudinary.

**Repo:** grzzly main blog repo (private)
**Script location:** `scripts/illustrate.py`
**Triggered by:** GitHub Actions as part of the blog publish workflow

**Flow:**
```
synthesise.py (Claude API) → post.json with cover_image_prompt + inline_image_prompt
→ illustrate.py → Ideogram V3 API → Cloudinary → URLs injected back into post.json
```

**Key technical decisions:**
- Uses **JSON body** (`Content-Type: application/json`), NOT multipart/form-data — this was the primary fix for quality parity with Ideogram UI
- Style reference images passed as **plain URL strings** in `style_reference_images` array — e.g. `["https://...", "https://..."]` — NOT as `{"url": "..."}` objects and NOT as file uploads
- Maximum **3 style reference images** — hard API limit; sending more silently degrades quality
- `magic_prompt_option: "OFF"` — correct parameter name (NOT `magic_prompt`); wrong name causes silent default to AUTO which rewrites prompts
- `rendering_speed: "QUALITY"` — API defaults to lower quality than UI
- `style_type` is NOT used when `style_reference_images` is present — they conflict
- `color_palette` parameter attempted but not yet fully resolved — pending test via JSON body

**Style reference images:** 3 images stored in `.github/style-refs/` in the blog repo. Also uploaded to Cloudinary:
- `https://res.cloudinary.com/djdmrz2fd/image/upload/v1772781622/ref1_c82yfr.jpg`
- `https://res.cloudinary.com/djdmrz2fd/image/upload/v1772781622/ref3_nmxh7b.webp`
- `https://res.cloudinary.com/djdmrz2fd/image/upload/v1772781622/ref2_cqgkzq.webp`

**Cloudinary folder structure:**
- Blog images: `blog/{pillar}/{YYYY-MM}/`
- Studio/ad-hoc images: `artwork/`

**Pending:**
- `color_palette` parameter — correct structure is `{"members": [{"colorHex": "#F7F6F1", "colorWeight": 1.0}, ...]}`, max 5 members, weights descending. Not yet tested via JSON body. Target palette: `#F7F6F1` (bg, 1.0), `#28272A` (0.8), `#B67D4A` (0.6), `#A655AA` (0.4), `#59AA55` (0.2).

---

### 2. LINE Illustration Studio bot

A Cloudflare Worker that acts as a LINE OA webhook — allows MW to generate illustrations on demand via LINE chat.

**GitHub repo:** `grzzly-dev/Mikael-Venne-Studio-LINE`
**Worker name:** `mikael-venne-studio-line`
**Worker URL:** `https://mikael-venne-studio-line.mong-ca0.workers.dev`
**Cloudflare account:** grzz.ly

**Flow:**
```
LINE message → CF Worker (webhook) → Ideogram V3 → Cloudinary → LINE push reply
```

**Mode system (KV-persisted per user):**
- Send `studio` → enters studio mode (every subsequent message becomes an image prompt)
- Send `done` → exits studio mode
- Normal mode → replies "Have you checked grzz.ly today?"

**KV namespace:**
- Binding: `STUDIO_STATE`
- ID: `875d5de03a1a45f28074907f22073e99`

**Worker secrets (set via `wrangler secret put` or CF dashboard):**
```
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
IDEOGRAM_API_KEY
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_SECRET
```

**wrangler.toml — current working state:**
```toml
name = "mikael-venne-studio-line"
main = "index.js"
compatibility_date = "2024-01-01"

[vars]
DEFAULT_PROMPT = "Editorial illustration. Loose expressive ink linework. Color palette restricted to: light creamy background, should be Pantone 663 C (Coated), Figure-forward whimsical composition with minimal negative space. Flat muted earth tones throughout, no gradients. Collage texture overlay, Gwendal Le Bec style. New Yorker magazine aesthetic. No text, no numbers, no labels, no lettering, no hexcode, no UI chrome."
STYLE_SUFFIX = "editorial illustration, loose expressive ink linework, flat muted color palette with earth tones, whimsical figurative composition, minimal background, collage texture overlay, Gwendal Le Bec style, New Yorker magazine aesthetic, no text, no letters, no numbers, no labels, no annotations, no diagrams"
STYLE_REF_URL_1 = "https://res.cloudinary.com/djdmrz2fd/image/upload/v1772781622/ref1_c82yfr.jpg"
STYLE_REF_URL_2 = "https://res.cloudinary.com/djdmrz2fd/image/upload/v1772781622/ref3_nmxh7b.webp"
STYLE_REF_URL_3 = "https://res.cloudinary.com/djdmrz2fd/image/upload/v1772781622/ref2_cqgkzq.webp"

[[kv_namespaces]]
binding = "STUDIO_STATE"
id = "875d5de03a1a45f28074907f22073e99"
```

**Key technical decisions:**
- Uses `ctx.waitUntil()` for async generation — LINE requires HTTP response within 5s, Ideogram QUALITY takes 30-60s. Worker acknowledges immediately then generates in background.
- Reply token used once for "⏳ Generating..." acknowledgement, then LINE `push` API used for final image + URL delivery (reply token is single-use).
- LINE webhook signature verified via HMAC-SHA256 on every request.
- Cloudinary upload uses SHA-1 signed upload with `folder=artwork`, `public_id=illus-{timestamp}`.

---

## Ideogram API — key facts discovered

| Parameter | Correct value | Notes |
|-----------|--------------|-------|
| Endpoint | `https://api.ideogram.ai/v1/ideogram-v3/generate` | Confirmed correct for V3 |
| Content-Type | `application/json` | NOT multipart — critical for quality parity with UI |
| `magic_prompt_option` | `"OFF"` | NOT `magic_prompt` — wrong name = silent AUTO rewrite |
| `rendering_speed` | `"QUALITY"` | API default is lower than UI default |
| `style_reference_images` | `["url1", "url2", "url3"]` | Plain string array, max 3 |
| `style_type` | omit when using style refs | Conflicts with `style_reference_images` |
| `color_palette` | `{"members": [...]}` | Pending test; max 5 members, weights 0.05–1.0 descending |
| Hex codes in prompt text | Ignored by model | Use descriptive colour language instead |

---

## Infrastructure overview

| Service | Purpose | Account |
|---------|---------|---------|
| Cloudflare Pages | Blog hosting (grzz.ly) | grzz.ly CF account |
| Cloudflare Workers | LINE bot webhook, quality receiver | grzz.ly CF account |
| Cloudflare KV | Studio mode state per user | STUDIO_STATE namespace |
| Cloudinary | Image CDN | `djdmrz2fd` cloud |
| GitHub Actions | Blog publish pipeline | grzzly-dev org |
| Ideogram V3 | Image generation | MW personal account |
| LINE Messaging API | OA channel — notifications + studio bot | grzzly channel |

---

## What to pick up next

1. Test `color_palette` parameter in `illustrate.py` via JSON body
2. Add `color_palette` to the CF Worker once confirmed working in Python
3. Quality comparison: LINE bot output vs Ideogram UI — should now be at parity with JSON body + URL refs
4. Consider aspect ratio toggle in LINE bot (`16x9` is hardcoded — could add `portrait` keyword for `9x16`)
