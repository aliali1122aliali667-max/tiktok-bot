import { config } from './config.js';

function nativeBaseUrl() {
  const base = config.ai.baseUrl.replace(/\/+$/, '');
  return base.replace(/\/openai$/i, '');
}

export function canGenerateImages() {
  return (
    /generativelanguage\.googleapis\.com/i.test(config.ai.baseUrl) &&
    /^AIza/.test(config.ai.apiKey)
  );
}

export async function editImageWithGemini(buffer, mimeType, instruction, timeoutMs = 120000) {
  const model = config.image.editModel;
  const url = `${nativeBaseUrl()}/models/${model}:generateContent`;

  const body = {
    contents: [
      {
        parts: [
          { text: (instruction || '').trim() || 'عدّل هذه الصورة بشكل جميل.' },
          { inlineData: { mimeType, data: Buffer.from(buffer).toString('base64') } },
        ],
      },
    ],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': config.ai.apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Gemini image API error ${response.status}`);
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((part) => part.inlineData?.data);
  const textPart = parts.find((part) => typeof part.text === 'string' && part.text.trim());

  if (!imagePart) {
    throw new Error(textPart?.text || 'لم يرجع مزود الذكاء الاصطناعي أي صورة');
  }

  return {
    buffer: Buffer.from(imagePart.inlineData.data, 'base64'),
    mime: imagePart.inlineData.mimeType || 'image/png',
    text: textPart?.text?.trim() || '',
  };
}
