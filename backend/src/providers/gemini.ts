import type { Env } from '../env';
import { providerFetch } from '../reliability';

export interface InlineImage {
  mimeType: string;
  data: string; // base64
}

/** Nano Banana image generation through the Gemini API, with optional reference images for consistency. */
export async function generateImage(
  env: Env,
  opts: { prompt: string; refs?: InlineImage[]; aspectRatio: string },
): Promise<InlineImage> {
  const model = env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1';
  const parts: unknown[] = [{ text: opts.prompt }];
  for (const r of (opts.refs ?? []).slice(0, 4)) parts.push({ inlineData: { mimeType: r.mimeType, data: r.data } });

  const res = await providerFetch('Gemini', `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: opts.aspectRatio, imageSize: '2K' },
      },
    }),
  }, 120_000);
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: InlineImage; inline_data?: { mime_type: string; data: string } }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    error?: { message: string };
  };
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${body.error?.message ?? 'unknown'}`);
  if (body.promptFeedback?.blockReason) throw new Error(`Image blocked by safety filter (${body.promptFeedback.blockReason}). Try rewording the shot.`);
  for (const p of body.candidates?.[0]?.content?.parts ?? []) {
    if (p.inlineData?.data) return p.inlineData;
    if (p.inline_data?.data) return { mimeType: p.inline_data.mime_type, data: p.inline_data.data };
  }
  throw new Error(`Gemini returned no image (finish reason ${body.candidates?.[0]?.finishReason ?? 'none'})`);
}
