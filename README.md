# line-illustrator

LINE OA bot that generates editorial illustrations via Ideogram V3, uploads to Cloudinary, and replies with the image + CDN URL.

## Flow

```
LINE message → Cloudflare Worker → Ideogram V3 → Cloudinary → LINE reply
```

## Usage

- Send any text → used as the image prompt (house style appended automatically)
- Send `go` or blank → uses `DEFAULT_PROMPT` from env

---

## Setup

### 1. Clone & install Wrangler

```bash
git clone https://github.com/YOUR_ORG/line-illustrator.git
cd line-illustrator
npm install -g wrangler
wrangler login
```

### 2. Deploy the Worker

```bash
wrangler deploy
```

Note the Worker URL: `https://line-illustrator.YOUR_SUBDOMAIN.workers.dev`

### 3. Set secrets in Cloudflare

Run each of these and paste the value when prompted:

```bash
wrangler secret put LINE_CHANNEL_SECRET
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
wrangler secret put IDEOGRAM_API_KEY
wrangler secret put CLOUDINARY_CLOUD_NAME
wrangler secret put CLOUDINARY_API_KEY
wrangler secret put CLOUDINARY_SECRET
```

Alternatively, set them in the Cloudflare dashboard:
**Workers & Pages → line-illustrator → Settings → Variables & Secrets → Add variable (Secret)**

### 4. Edit plain env vars

In `wrangler.toml` under `[vars]`, update:
- `DEFAULT_PROMPT` — fallback prompt
- `STYLE_SUFFIX` — house style appended to every prompt
- `STYLE_REF_URL_1/2/3` — Cloudinary URLs of your 3 style reference images

After editing `wrangler.toml`, redeploy:
```bash
wrangler deploy
```

Or edit directly in CF dashboard without redeploying:
**Workers & Pages → line-illustrator → Settings → Variables & Secrets**

### 5. Point LINE webhook to Worker

In LINE Developers console:
- **Messaging API → Webhook URL**: `https://line-illustrator.YOUR_SUBDOMAIN.workers.dev`
- Enable **Use webhook**: ON
- Disable **Auto-reply messages**: OFF
- Disable **Greeting messages**: OFF (optional)

### 6. Test

Send any message to your LINE OA. You should receive:
1. `⏳ Generating your illustration...`
2. The generated image
3. The Cloudinary CDN URL

---

## Env vars reference

| Name | Type | Description |
|------|------|-------------|
| `LINE_CHANNEL_SECRET` | Secret | Webhook signature verification |
| `LINE_CHANNEL_ACCESS_TOKEN` | Secret | Send messages |
| `IDEOGRAM_API_KEY` | Secret | Ideogram V3 API |
| `CLOUDINARY_CLOUD_NAME` | Secret | e.g. `mycloud` |
| `CLOUDINARY_API_KEY` | Secret | Cloudinary API key |
| `CLOUDINARY_SECRET` | Secret | Cloudinary API secret |
| `DEFAULT_PROMPT` | Plain | Fallback prompt when user sends `go` |
| `STYLE_SUFFIX` | Plain | House style appended to every prompt |
| `STYLE_REF_URL_1/2/3` | Plain | Style reference image CDN URLs |
