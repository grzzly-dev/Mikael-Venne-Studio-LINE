/**
 * line-illustrator — Cloudflare Worker
 *
 * Modes:
 *   Normal  — replies "Have you checked grzz.ly today?"
 *   Studio  — every message becomes an Ideogram illustration prompt
 *
 * Trigger words:
 *   "studio" → enter studio mode
 *   "done"   → exit studio mode
 *
 * Secrets (wrangler secret put):
 *   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
 *   IDEOGRAM_API_KEY
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_SECRET
 *
 * Plain env vars (wrangler.toml [vars]):
 *   DEFAULT_PROMPT, STYLE_SUFFIX
 *   STYLE_REF_URL_1 / _2 / _3
 *
 * KV (wrangler.toml [[kv_namespaces]]):
 *   STUDIO_STATE — persists per-user mode
 */

const IDEOGRAM_API   = "https://api.ideogram.ai/v1/ideogram-v3/generate";
const LINE_REPLY_API = "https://api.line.me/v2/bot/message/reply";
const LINE_PUSH_API  = "https://api.line.me/v2/bot/message/push";
const CLOUDINARY_API = (cloud) => `https://api.cloudinary.com/v1_1/${cloud}/image/upload`;

// ── LINE signature verification ───────────────────────────────────────────────
async function verifyLineSignature(body, signature, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expected === signature;
}

// ── LINE messaging ────────────────────────────────────────────────────────────
async function replyText(replyToken, text, token) {
  await fetch(LINE_REPLY_API, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
}

async function pushText(userId, text, token) {
  await fetch(LINE_PUSH_API, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
}

async function pushImageAndUrl(userId, cdnUrl, token) {
  await fetch(LINE_PUSH_API, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      to: userId,
      messages: [
        { type: "image", originalContentUrl: cdnUrl, previewImageUrl: cdnUrl },
        { type: "text", text: `🖼 ${cdnUrl}` },
      ],
    }),
  });
}

// ── KV mode helpers ───────────────────────────────────────────────────────────
async function isStudioMode(userId, kv) {
  const val = await kv.get(`mode:${userId}`);
  return val === "studio";
}

async function setStudioMode(userId, kv, active) {
  if (active) {
    await kv.put(`mode:${userId}`, "studio");
  } else {
    await kv.delete(`mode:${userId}`);
  }
}

// ── Ideogram V3 ───────────────────────────────────────────────────────────────
async function generateImage(prompt, env) {
  const styleRefs = [env.STYLE_REF_URL_1, env.STYLE_REF_URL_2, env.STYLE_REF_URL_3].filter(Boolean);

  const payload = {
    prompt,
    aspect_ratio: "16x9",
    magic_prompt_option: "OFF",
    rendering_speed: "QUALITY",
  };

  if (styleRefs.length > 0) payload.style_reference_images = styleRefs;

  const resp = await fetch(IDEOGRAM_API, {
    method: "POST",
    headers: { "Api-Key": env.IDEOGRAM_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) throw new Error(`Ideogram ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const imageUrl = data?.data?.[0]?.url;
  if (!imageUrl) throw new Error("No image URL in Ideogram response");
  return imageUrl;
}

// ── Cloudinary upload ─────────────────────────────────────────────────────────
async function uploadToCloudinary(imageUrl, env) {
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) throw new Error(`Failed to fetch image: ${imgResp.status}`);

  const bytes = new Uint8Array(await imgResp.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const dataUri = `data:image/png;base64,${btoa(binary)}`;

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = "artwork";
  const publicId = `illus-${timestamp}`;
  const sigString = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${env.CLOUDINARY_SECRET}`;

  const sigHash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(sigString));
  const signature = Array.from(new Uint8Array(sigHash)).map((b) => b.toString(16).padStart(2, "0")).join("");

  const form = new FormData();
  form.append("file", dataUri);
  form.append("folder", folder);
  form.append("public_id", publicId);
  form.append("timestamp", String(timestamp));
  form.append("api_key", env.CLOUDINARY_API_KEY);
  form.append("signature", signature);

  const upResp = await fetch(CLOUDINARY_API(env.CLOUDINARY_CLOUD_NAME), { method: "POST", body: form });
  if (!upResp.ok) throw new Error(`Cloudinary ${upResp.status}: ${await upResp.text()}`);

  return (await upResp.json()).secure_url;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    const rawBody = await request.text();
    const signature = request.headers.get("x-line-signature") || "";

    const valid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
    if (!valid) return new Response("Unauthorized", { status: 401 });

    const events = JSON.parse(rawBody).events || [];

    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") continue;

      const replyToken = event.replyToken;
      const userId = event.source.userId;
      const userText = event.message.text.trim();
      const lowerText = userText.toLowerCase();

      // ── Mode switch commands ──
      if (lowerText === "studio") {
        await setStudioMode(userId, env.STUDIO_STATE, true);
        await replyText(replyToken, "🎨 Studio mode on. Send me any prompt and I'll illustrate it.", env.LINE_CHANNEL_ACCESS_TOKEN);
        break;
      }

      if (lowerText === "done") {
        await setStudioMode(userId, env.STUDIO_STATE, false);
        await replyText(replyToken, "✅ Studio mode off.", env.LINE_CHANNEL_ACCESS_TOKEN);
        break;
      }

      // ── Check current mode ──
      const studioActive = await isStudioMode(userId, env.STUDIO_STATE);

      if (!studioActive) {
        await replyText(replyToken, "Have you checked grzz.ly today?", env.LINE_CHANNEL_ACCESS_TOKEN);
        break;
      }

      // ── Studio mode — treat message as image prompt ──
      const basePrompt = (!userText || lowerText === "go")
        ? (env.DEFAULT_PROMPT || "a lone figure walking through a vast empty city at dusk")
        : userText;

      const styleSuffix = env.STYLE_SUFFIX || "";
      const fullPrompt = styleSuffix ? `${basePrompt}, ${styleSuffix}` : basePrompt;

      // Acknowledge immediately (LINE 5s reply window)
      await replyText(replyToken, "⏳ Generating your illustration...", env.LINE_CHANNEL_ACCESS_TOKEN);

      // Generate in background — survives past HTTP response
      ctx.waitUntil(
        (async () => {
          try {
            const ideogramUrl = await generateImage(fullPrompt, env);
            const cdnUrl = await uploadToCloudinary(ideogramUrl, env);
            await pushImageAndUrl(userId, cdnUrl, env.LINE_CHANNEL_ACCESS_TOKEN);
          } catch (err) {
            await pushText(userId, `❌ Error: ${err.message}`, env.LINE_CHANNEL_ACCESS_TOKEN);
          }
        })()
      );

      break;
    }

    return new Response("OK", { status: 200 });
  },
};