import Jimp from 'jimp';

const FILTERS = [
  {
    id: 'grayscale',
    label: 'رمادي (أبيض وأسود)',
    aliases: ['grayscale', 'greyscale', 'gray', 'grey', 'رمادي', 'ابيض واسود'],
    apply: (image) => image.greyscale(),
  },
  {
    id: 'sepia',
    label: 'سيبيا (بني قديم)',
    aliases: ['sepia', 'سيبيا', 'بني', 'قديم'],
    apply: (image) => image.sepia(),
  },
  {
    id: 'invert',
    label: 'معكوس (نيجاتيف)',
    aliases: ['invert', 'negative', 'معكوس', 'عكسي', 'نيجاتيف'],
    apply: (image) => image.invert(),
  },
  {
    id: 'blur',
    label: 'ضبابي',
    aliases: ['blur', 'ضبابي', 'ضباب', 'تمويه'],
    apply: (image) => image.blur(4),
  },
  {
    id: 'bright',
    label: 'مضيء',
    aliases: ['bright', 'brightness', 'مضيء', 'ساطع', 'اضاءة'],
    apply: (image) => image.brightness(0.25),
  },
  {
    id: 'dark',
    label: 'داكن',
    aliases: ['dark', 'داكن', 'غامق', 'تعتيم'],
    apply: (image) => image.brightness(-0.25),
  },
  {
    id: 'contrast',
    label: 'تباين',
    aliases: ['contrast', 'تباين', 'وضوح'],
    apply: (image) => image.contrast(0.3),
  },
  {
    id: 'sharpen',
    label: 'حدة',
    aliases: ['sharpen', 'حدة', 'حاد', 'توضيح'],
    apply: (image) => image.convolute([[0, -1, 0], [-1, 5, -1], [0, -1, 0]]),
  },
  {
    id: 'posterize',
    label: 'بوسترة (ألوان محدودة)',
    aliases: ['posterize', 'بوسترة'],
    apply: (image) => image.posterize(4),
  },
  {
    id: 'pixelate',
    label: 'بكسل',
    aliases: ['pixelate', 'pixel', 'بكسل', 'مربعات'],
    apply: (image) => image.pixelate(8),
  },
  {
    id: 'mirror',
    label: 'مرايا (قلب أفقي)',
    aliases: ['mirror', 'flip', 'مرايا', 'قلب'],
    apply: (image) => image.mirror(true, false),
  },
  {
    id: 'flipVertical',
    label: 'قلب رأسي',
    aliases: ['flipv', 'vertical', 'قلب رايسي', 'قلب رأسي'],
    apply: (image) => image.mirror(false, true),
  },
  {
    id: 'rotate',
    label: 'تدوير 90 درجة',
    aliases: ['rotate', 'تدوير', 'دوران'],
    apply: (image) => image.rotate(90),
  },
  {
    id: 'warm',
    label: 'دافئ',
    aliases: ['warm', 'دافي', 'دافئ'],
    apply: (image) =>
      image.color([{ apply: 'red', params: [12] }, { apply: 'green', params: [8] }]),
  },
  {
    id: 'cool',
    label: 'بارد',
    aliases: ['cool', 'بارد'],
    apply: (image) => image.color([{ apply: 'blue', params: [15] }]),
  },
  {
    id: 'dither',
    label: 'نقطي (Dithering)',
    aliases: ['dither', 'نقطي'],
    apply: (image) => image.dither565(),
  },
];

function normalize(value) {
  return String(value ?? '')
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .trim()
    .toLowerCase();
}

export function resolveFilter(name) {
  const target = normalize(name);
  if (!target) return null;
  return (
    FILTERS.find((filter) => normalize(filter.id) === target) ||
    FILTERS.find((filter) => filter.aliases.some((alias) => normalize(alias) === target)) ||
    null
  );
}

export function listFilters() {
  return FILTERS.map(({ id, label }) => ({ id, label }));
}

export function filtersHelp() {
  const lines = ['الفلاتر المتوفرة:', ''];
  FILTERS.forEach((filter, index) => {
    lines.push(`${index + 1}) ${filter.label} - ${filter.id}`);
  });
  lines.push('');
  lines.push('طريقة الاستخدام: أرسل صورة مع تعليق بالشكل: فلتر رمادي');
  return lines.join('\n');
}

export async function fetchImage(url, timeoutMs = 30000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download image (status ${response.status})`);
  }
  const mime = response.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mime };
}

export function toDataUrl(buffer, mimeType = 'image/jpeg') {
  const base64 = Buffer.from(buffer).toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

export async function applyImageFilter(buffer, filterName, mimeType = 'image/jpeg') {
  const filter = resolveFilter(filterName);
  if (!filter) {
    return { ok: false, error: 'unknown-filter' };
  }

  const image = await Jimp.read(buffer);
  filter.apply(image);

  const mime = String(mimeType).includes('png') ? Jimp.MIME_PNG : Jimp.MIME_JPEG;
  const output = await image.getBufferAsync(mime);

  return { ok: true, buffer: output, mime, filter };
}
