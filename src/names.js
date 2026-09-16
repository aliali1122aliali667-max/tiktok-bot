const ARABIC_RE = /[\u0600-\u06FF]/;
const LATIN_RE = /[A-Za-z]/;

function mapChars(text, { upper, lower, digit, exceptions = {} }) {
  let out = '';
  for (const ch of text) {
    if (exceptions[ch]) {
      out += exceptions[ch];
      continue;
    }
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) {
      out += String.fromCodePoint(upper + (code - 65));
    } else if (code >= 97 && code <= 122) {
      out += String.fromCodePoint(lower + (code - 97));
    } else if (digit && code >= 48 && code <= 57) {
      out += String.fromCodePoint(digit + (code - 48));
    } else {
      out += ch;
    }
  }
  return out;
}

const SMALL_CAPS = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ',
  j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ',
  s: 's', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
};

const UPSIDE_DOWN = {
  a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ',
  j: 'ɾ', k: 'ʞ', l: 'l', m: 'ɯ', n: 'u', o: 'o', p: 'd', q: 'b', r: 'ɹ',
  s: 's', t: 'ʇ', u: 'n', v: 'ʌ', w: 'ʍ', x: 'x', y: 'ʎ', z: 'z',
  A: '∀', B: '𐐒', C: 'Ɔ', D: 'ᗡ', E: 'Ǝ', F: 'Ⅎ', G: 'פ', H: 'H', I: 'I',
  J: 'ſ', K: 'ʞ', L: '˥', M: 'W', N: 'N', O: 'O', P: 'Ԁ', Q: 'Ό', R: 'ᴚ',
  S: 'S', T: '⊥', U: '∩', V: 'Λ', W: 'M', X: 'X', Y: '⅄', Z: 'Z',
};

const EN_STYLES = [
  { id: 'bold', label: 'عريض', map: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce } },
  {
    id: 'italic',
    label: 'مائل',
    map: { upper: 0x1d434, lower: 0x1d44e, digit: 0x1d7ce, exceptions: { h: 'ℎ' } },
  },
  { id: 'boldItalic', label: 'عريض مائل', map: { upper: 0x1d468, lower: 0x1d482, digit: 0x1d7ce } },
  { id: 'sansBold', label: 'عريض بسيط', map: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec } },
  { id: 'mono', label: 'آلة كاتبة', map: { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 } },
  {
    id: 'script',
    label: 'خط مزخرف',
    map: {
      upper: 0x1d49c,
      lower: 0x1d4b6,
      digit: 0x1d7ce,
      exceptions: {
        B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ',
        e: 'ℯ', g: 'ℊ', o: 'ℴ',
      },
    },
  },
  {
    id: 'double',
    label: 'مزدوج الخط',
    map: {
      upper: 0x1d538,
      lower: 0x1d552,
      digit: 0x1d7d8,
      exceptions: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' },
    },
  },
  { id: 'fullwidth', label: 'عريض كامل', map: { upper: 0xff21, lower: 0xff41, digit: 0xff10 } },
  { id: 'circled', label: 'دائري', map: { upper: 0x24b6, lower: 0x24d0 } },
];

const ARABIC_NON_JOINING = new Set([
  '\u0627', '\u0623', '\u0625', '\u0622', '\u0671', '\u062f', '\u0630', '\u0631',
  '\u0632', '\u0648', '\u0624', '\u0629', '\u0621', '\u0649',
]);

function stretchArabic(text) {
  const chars = [...text];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const current = chars[i];
    const next = chars[i + 1];
    out += current;
    if (
      next &&
      ARABIC_RE.test(current) &&
      ARABIC_RE.test(next) &&
      !ARABIC_NON_JOINING.has(current)
    ) {
      out += '\u0640';
    }
  }
  return out;
}

const FRAMES = [
  { id: 'ornate', label: 'مزخرف فخم', prefix: '꧁ঔৣ☬ ', suffix: ' ☬ঔৣ꧂' },
  { id: 'stars', label: 'نجوم', prefix: '★彡 ', suffix: ' 彡★' },
  { id: 'flower', label: 'أزهار', prefix: '✿❀ ', suffix: ' ❀✿' },
  { id: 'crown', label: 'تاج', prefix: '♛ ', suffix: ' ♛' },
  { id: 'heart', label: 'قلوب', prefix: '❥ ', suffix: ' ❥' },
  { id: 'mountain', label: 'جبال', prefix: '༺ ', suffix: ' ༻' },
  { id: 'wave', label: 'موجات', prefix: '⊰⊱ ', suffix: ' ⊰⊱' },
  { id: 'diamond', label: 'ماسات', prefix: '◆ ', suffix: ' ◆' },
  { id: 'arrow', label: 'أسهم', prefix: '➽ ', suffix: ' ➽' },
  { id: 'double', label: 'مزدوج', prefix: '╰•★ ', suffix: ' ★•╯' },
  { id: 'arabic', label: 'أقواس عربية', prefix: '﴿ ', suffix: ' ﴾' },
];

function styleSmallCaps(text) {
  return [...text].map((ch) => SMALL_CAPS[ch] ?? SMALL_CAPS[ch.toLowerCase()] ?? ch).join('');
}

function styleUpsideDown(text) {
  return [...text]
    .reverse()
    .map((ch) => UPSIDE_DOWN[ch] ?? ch)
    .join('');
}

export function decorateName(rawName) {
  const name = String(rawName ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40);
  if (!name) return null;

  const hasArabic = ARABIC_RE.test(name);
  const hasLatin = LATIN_RE.test(name);
  const base = hasArabic ? stretchArabic(name) : name;
  const styles = [];

  if (hasLatin) {
    for (const style of EN_STYLES) {
      const value = mapChars(name, style.map);
      if (value !== name) {
        styles.push({ id: style.id, label: style.label, value });
      }
    }
    const small = styleSmallCaps(name);
    if (small !== name) styles.push({ id: 'smallCaps', label: 'حروف صغيرة', value: small });
    styles.push({ id: 'upsideDown', label: 'مقلوب', value: styleUpsideDown(name) });
  }

  if (hasArabic && base !== name) {
    styles.push({ id: 'stretch', label: 'مشدود', value: base });
  }

  for (const frame of FRAMES) {
    styles.push({
      id: `frame-${frame.id}`,
      label: `إطار ${frame.label}`,
      value: `${frame.prefix}${base}${frame.suffix}`,
    });
  }

  return { name, styles };
}

export function formatDecoratedNames(rawName) {
  const result = decorateName(rawName);
  if (!result) return null;

  const lines = [`الأسماء المزخرفة لـ «${result.name}»:`, ''];
  result.styles.forEach((style, index) => {
    lines.push(`${index + 1}) ${style.value}`);
  });
  lines.push('');
  lines.push('انسخ الاسم اللي يعجبك.');
  return lines.join('\n');
}

export function nameStyleCount(rawName) {
  const result = decorateName(rawName);
  return result ? result.styles.length : 0;
}
