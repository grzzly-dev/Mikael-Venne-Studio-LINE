/**
 * line-illustrator — Cloudflare Worker
 *
 * Flow:
 *   LINE user sends text → Worker verifies signature → calls Ideogram V3
 *   → uploads to Cloudinary → replies with image + CDN URL via LINE
 *
 * Env vars (set as secrets in CF dashboard):
 *   LINE_CHANNEL_SECRET        — for webhook signature verification
 *   LINE_CHANNEL_ACCESS_TOKEN  — for sending replies
 *   IDEOGRAM_API_KEY
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_SECRET
 *
 * Plain env vars (editable in CF dashboard without redeployment):
 *   DEFAULT_PROMPT    — fallback prompt when user sends "go" or blank
 *   STYLE_SUFFIX      — house style appended to every prompt
 *   STYLE_REF_URL_1   — style reference image URL (optional)
 *   STYLE_REF_URL_2   — style reference image URL (optional)
 *   STYLE_REF_URL_3   — style reference image URL (optional)
 */

const IDEOGRAM_API    = "https://api.ideogram.ai/v1/ideogram-v3/generate";
const LINE_REPLY_API  = "https://api.line.me/v2/bot/message/reply";
const CLOUDINARY_API  = (cloud) => `https://api.cloudinary.com/v1_1/${cloud}/image/upload`;

// ── Signature verification ────────────────────────────────────────────────────
async function verifyLineSignature(body, signature, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expected === signature;
}

// ── Ideogram V3 ───────────────────────────────────────────────────────────────
async function generateImage(prompt, env) {
  const styleRefs = [
    env.STYLE_REF_URL_1,
    env.STYLE_REF_URL_2,
    env.STYLE_REF_URL_3,
  ].filter(Boolean);

  const payload = {
    prompt,
    aspect_ratio: "16x9",
    magic_prompt_option: "OFF",
    rendering_speed: "QUALITY",
  };

  if (styleRefs.length > 0) {
    payload.style_reference_images = styleRefs;
  }

  const resp = await fetch(IDEOGRAM_API, {
    method: "POST",
    headers: {
      "Api-Key": env.IDEOGRAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Ideogram error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const imageUrl = data?.data?.[0]?.url;
  if (!imageUrl) throw new Error("No image URL in Ideogram response");
  return imageUrl;
}

// ── Cloudinary upload ─────────────────────────────────────────────────────────
async function uploadToCloudinary(imageUrl, env) {
  // Fetch image bytes from Ideogram CDN
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) throw new Error(`Failed to fetch image: ${imgResp.status}`);
  const imgBuffer = await imgResp.arrayBuffer();

  // Base64 encode
  const bytes = new Uint8Array(imgBuffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  const dataUri = `data:image/png;base64,${b64}`;

  // Build auth signature
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = "artwork";
  const publicId = `illus-${timestamp}`;
  const sigString = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${env.CLOUDINARY_SECRET}`;

  const sigHash = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(sigString)
  );
  const signature = Array.from(new Uint8Array(sigHash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const form = new FormData();
  form.append("file", dataUri);
  form.append("folder", folder);
  form.append("public_id", publicId);
  form.append("timestamp", String(timestamp));
  form.append("api_key", env.CLOUDINARY_API_KEY);
  form.append("signature", signature);

  const upResp = await fetch(CLOUDINARY_API(env.CLOUDINARY_CLOUD_NAME), {
    method: "POST",
    body: form,
  });

  if (!upResp.ok) {
    const err = await upResp.text();
    throw new Error(`Cloudinary error ${upResp.status}: ${err}`);
  }

  const upData = await upResp.json();
  return upData.secure_url;
}

// ── LINE reply ────────────────────────────────────────────────────────────────
async function replyToLine(replyToken, messages, token) {
  await fetch(LINE_REPLY_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

async function replyText(replyToken, text, token) {
  await replyToLine(replyToken, [{ type: "text", text }], token);
}

async function replyImageAndUrl(replyToken, cdnUrl, token) {
  await replyToLine(replyToken, [
    {
      type: "image",
      originalContentUrl: cdnUrl,
      previewImageUrl: cdnUrl,
    },
    {
      type: "text",
      text: `🖼 ${cdnUrl}`,
    },
  ], token);
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-line-signature") || "";

    // Verify LINE signature
    const valid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
    if (!valid) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const events = body.events || [];

    // Process only the first message event
    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") continue;

      const replyToken = event.replyToken;
      const userText = event.message.text.trim();

      // Determine prompt
      const isDefault = !userText || userText.toLowerCase() === "go";
      const basePrompt = isDefault
        ? (env.DEFAULT_PROMPT || "a lone figure walking through a vast empty city at dusk")
        : userText;

      const styleSuffix = env.STYLE_SUFFIX || "";
      const fullPrompt = styleSuffix ? `${basePrompt}, ${styleSuffix}` : basePrompt;

      // Acknowledge immediately (LINE times out in 5s for replies)
      await replyText(replyToken, "⏳ Generating your illustration...", env.LINE_CHANNEL_ACCESS_TOKEN);

      try {
        // Generate
        const ideogramUrl = await generateImage(fullPrompt, env);

        // Upload
        const cdnUrl = await uploadToCloudinary(ideogramUrl, env);

        // Push result (can't reuse replyToken after first reply — use push)
        const userId = event.source.userId;
        await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: userId,
            messages: [
              {
                type: "image",
                originalContentUrl: cdnUrl,
                previewImageUrl: cdnUrl,
              },
              {
                type: "text",
                text: `🖼 ${cdnUrl}`,
              },
            ],
          }),
        });

      } catch (err) {
        // Push error message
        const userId = event.source.userId;
        await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: userId,
            messages: [{ type: "text", text: `❌ Error: ${err.message}` }],
          }),
        });
      }

      break; // handle one event per request
    }

    return new Response("OK", { status: 200 });
  },
};
