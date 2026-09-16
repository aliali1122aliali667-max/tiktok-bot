import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ============================================================
// إعدادات عامة لميزة الأرقام الوهمية
// ============================================================

// مهلة كل طلب HTTP بالمللي ثانية
const REQUEST_TIMEOUT_MS = 20000;

// مدة صلاحية جلسة الرقم (24 ساعة) وفترة التنظيف (ساعة)
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// الحد اليومي الافتراضي لإنشاء الأرقام لكل مستخدم
const DEFAULT_DAILY_SMS_LIMIT = 5;
const DAILY_SMS_LIMIT =
  Number.parseInt(process.env.DAILY_SMS_LIMIT ?? '', 10) || DEFAULT_DAILY_SMS_LIMIT;

// ملف التخزين المحلي لجلسات المستخدمين وإحصاءاتهم
const DATA_FILE = join(process.cwd(), 'data', 'sms-data.json');

// User-Agent ثابت لطلبات الويب سكرابنغ
const SCRAPER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

// ============================================================
// المزودون: الترتيب وأسماء العرض
// ============================================================

function normalizeProvider(value) {
  const name = String(value ?? '').trim().toLowerCase();
  if (name === 'sms-receive' || name === 'smsreceive') return 'sms-receive';
  if (name === 'receive-smss' || name === 'receivesmss') return 'receive-smss';
  if (name === 'quackr') return 'quackr';
  return '';
}

const PROVIDER_PRIMARY =
  normalizeProvider(process.env.SMS_PROVIDER_PRIMARY) || 'sms-receive';
const PROVIDER_FALLBACK1 =
  normalizeProvider(process.env.SMS_PROVIDER_FALLBACK1) || 'receive-smss';
const PROVIDER_FALLBACK2 =
  normalizeProvider(process.env.SMS_PROVIDER_FALLBACK2) || 'quackr';

const QUACKR_API_KEY = String(process.env.QUACKR_API_KEY ?? '').trim();

// ترتيب المزودين مع استبعاد quackr إذا لم يكن هناك مفتاح
function providerOrder() {
  const list = [PROVIDER_PRIMARY, PROVIDER_FALLBACK1, PROVIDER_FALLBACK2].filter(Boolean);
  const unique = [...new Set(list)];
  return unique.filter((provider) => (provider === 'quackr' ? Boolean(QUACKR_API_KEY) : true));
}

function providerLabel(provider) {
  if (provider === 'sms-receive') return 'sms-receive';
  if (provider === 'receive-smss') return 'receive-smss';
  if (provider === 'quackr') return 'quackr';
  return provider ?? 'غير معروف';
}

// ============================================================
// قائمة الدول المدعومة
// ============================================================

// كل دولة لها رمز داخلي + علم + مسارات المواقع المجانية + كود بلد للـ quackr
const COUNTRIES = {
  us: {
    code: 'us',
    label: 'الولايات المتحدة',
    flag: '🇺🇸',
    dial: '+1',
    smsReceivePaths: ['/us/', '/country/united-states/'],
    receiveSmssPaths: ['/sms/united-states/', '/country/united-states/'],
    quackrCountry: 'US',
  },
  uk: {
    code: 'uk',
    label: 'المملكة المتحدة',
    flag: '🇬🇧',
    dial: '+44',
    smsReceivePaths: ['/uk/', '/country/united-kingdom/'],
    receiveSmssPaths: ['/sms/united-kingdom/', '/country/united-kingdom/'],
    quackrCountry: 'GB',
  },
  sa: {
    code: 'sa',
    label: 'السعودية',
    flag: '🇸🇦',
    dial: '+966',
    smsReceivePaths: ['/sa/', '/country/saudi-arabia/'],
    receiveSmssPaths: ['/sms/saudi-arabia/', '/country/saudi-arabia/'],
    quackrCountry: 'SA',
  },
};

export function getCountry(code) {
  return COUNTRIES[String(code ?? '').toLowerCase()] || null;
}

export function listCountries() {
  return Object.values(COUNTRIES);
}

// ============================================================
// أدوات مساعدة عامة
// ============================================================

async function httpRequest(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();

    let data = raw;
    if (raw && (options.expect === 'json' || (response.headers.get('content-type') || '').includes('json'))) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }

    if (!response.ok) {
      const message =
        typeof data === 'object' && data
          ? data.message ?? data.detail ?? response.statusText
          : response.statusText;
      const text = Array.isArray(message) ? message.join(', ') : message;
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function pickRandom(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[randomInt(list.length)];
}

// تحويل HTML إلى نص عادي مبسّط
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|td|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(text, max = 3500) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}\n...(تم الاختصار)` : value;
}

// استخراج أرقام الهواتف من صفحة HTML بواسطة regex عام
function extractPhoneLinks(html, baseUrl) {
  if (!html) return [];
  const results = new Map();

  // نمط 1: روابط <a href="/sms/1234567890"> أو /number/1234567890
  const linkPattern = /href=["']([^"']*(?:sms|number|receive|inbox)[^"']*\+?\d{7,15}[^"']*)["']/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = match[1];
    const numberMatch = href.match(/\+?\d{7,15}/);
    if (!numberMatch) continue;
    const number = numberMatch[0].startsWith('+') ? numberMatch[0] : `+${numberMatch[0]}`;
    const url = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
    if (!results.has(number)) results.set(number, url);
  }

  // نمط 2: أرقام مكشوفة في نص الصفحة (كخطة احتياطية)
  if (results.size === 0) {
    const numberPattern = /\+\d{7,15}/g;
    while ((match = numberPattern.exec(html)) !== null) {
      const number = match[0];
      if (!results.has(number)) results.set(number, baseUrl);
    }
  }

  return [...results.entries()].map(([number, url]) => ({ number, url }));
}

// ============================================================
// مزود sms-receive (مجاني - أساسي)
// ============================================================

const SMS_RECEIVE_BASE = 'https://sms-receive.net';

async function pickSmsReceiveNumber(country) {
  const paths = country.smsReceivePaths || [];
  let lastError = null;

  for (const path of paths) {
    try {
      const url = `${SMS_RECEIVE_BASE}${path}`;
      const html = await httpRequest(url, { headers: SCRAPER_HEADERS });
      const numbers = extractPhoneLinks(html, SMS_RECEIVE_BASE);
      const choice = pickRandom(numbers);
      if (choice) {
        return {
          provider: 'sms-receive',
          number: choice.number,
          url: choice.url,
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('لا توجد أرقام متاحة في sms-receive');
}

async function fetchSmsReceiveMessages(session) {
  const html = await httpRequest(session.url, { headers: SCRAPER_HEADERS });
  return parseGenericMessages(html);
}

// ============================================================
// مزود receive-smss (مجاني - احتياطي أول)
// ============================================================

const RECEIVE_SMSS_BASE = 'https://receive-smss.com';

async function pickReceiveSmssNumber(country) {
  const paths = country.receiveSmssPaths || [];
  let lastError = null;

  for (const path of paths) {
    try {
      const url = `${RECEIVE_SMSS_BASE}${path}`;
      const html = await httpRequest(url, { headers: SCRAPER_HEADERS });
      const numbers = extractPhoneLinks(html, RECEIVE_SMSS_BASE);
      const choice = pickRandom(numbers);
      if (choice) {
        return {
          provider: 'receive-smss',
          number: choice.number,
          url: choice.url,
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('لا توجد أرقام متاحة في receive-smss');
}

async function fetchReceiveSmssMessages(session) {
  const html = await httpRequest(session.url, { headers: SCRAPER_HEADERS });
  return parseGenericMessages(html);
}

// ============================================================
// مزود quackr (مدفوع - احتياطي ثاني)
// ============================================================

const QUACKR_BASE = 'https://api.quackr.io';

function quackrHeaders() {
  return {
    accept: 'application/json',
    'x-api-key': QUACKR_API_KEY,
  };
}

async function pickQuackrNumber(country) {
  if (!QUACKR_API_KEY) throw new Error('مفتاح quackr غير مضبوط');

  // جلب قائمة الأرقام المتاحة عند quackr
  const list = await httpRequest(
    `${QUACKR_BASE}/numbers?country=${encodeURIComponent(country.quackrCountry)}`,
    { headers: quackrHeaders(), expect: 'json' }
  );

  const numbers = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : [];
  const choice = pickRandom(numbers);
  if (!choice) throw new Error('لا يوجد رقم متاح في quackr');

  const number = choice.number || choice.phoneNumber || choice.phone || '';
  if (!number) throw new Error('استجابة quackr غير متوقعة');

  return {
    provider: 'quackr',
    number: number.startsWith('+') ? number : `+${number}`,
    url: `${QUACKR_BASE}/numbers/${encodeURIComponent(number)}/messages`,
  };
}

async function fetchQuackrMessages(session) {
  const data = await httpRequest(session.url, { headers: quackrHeaders(), expect: 'json' });
  const items = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];

  return items.map((item, index) => ({
    id: item.id ?? String(index + 1),
    from: item.from || item.sender || 'مجهول',
    subject: '',
    body: item.body || item.text || item.message || '',
    date: item.receivedAt || item.date || '',
  }));
}

// ============================================================
// محلّل عام للرسائل من صفحات HTML
// ============================================================

// يحاول استخراج الرسائل من جدول أو من عناصر تكرارية
function parseGenericMessages(html) {
  if (!html) return [];
  const messages = [];

  // نمط الجداول: <tr>...<td>from</td><td>message</td><td>date</td>...</tr>
  const rowPattern = /<tr[\s\S]*?<\/tr>/gi;
  const rows = html.match(rowPattern) || [];

  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => htmlToText(m[1]));
    if (cells.length >= 2) {
      const [from, body, date] = cells;
      if (body && body.length > 1) {
        messages.push({
          id: String(messages.length + 1),
          from: from || 'مجهول',
          subject: '',
          body,
          date: date || '',
        });
      }
    }
  }

  // بديل: divs بكلاس message أو sms
  if (messages.length === 0) {
    const divPattern =
      /<div[^>]*class=["'][^"']*(?:message|sms|msg|item)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
    let match;
    while ((match = divPattern.exec(html)) !== null) {
      const text = htmlToText(match[1]);
      if (text && text.length > 1) {
        messages.push({
          id: String(messages.length + 1),
          from: 'مجهول',
          subject: '',
          body: text,
          date: '',
        });
      }
      if (messages.length >= 20) break;
    }
  }

  return messages.slice(0, 20);
}

// ============================================================
// التخزين المحلي (ملف JSON)
// ============================================================

// جلسات المستخدمين وإحصاءاتهم في الذاكرة، مع مزامنة إلى ملف JSON
const userSessions = new Map();
const dailyStats = new Map();
let storageLoaded = false;

async function ensureStorageLoaded() {
  if (storageLoaded) return;
  storageLoaded = true;

  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === 'object') {
      for (const [chatId, session] of Object.entries(parsed.sessions || {})) {
        userSessions.set(Number(chatId), session);
      }
      for (const [chatId, stat] of Object.entries(parsed.dailyStats || {})) {
        dailyStats.set(Number(chatId), stat);
      }
    }
  } catch (error) {
    // الملف غير موجود أو تالف - نبدأ بحالة فارغة
  }
}

let saveTimer = null;
async function persistStorage() {
  // تجميع كتابات متعددة خلال 500ms في كتابة واحدة
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await mkdir(dirname(DATA_FILE), { recursive: true });
      const payload = {
        sessions: Object.fromEntries(userSessions),
        dailyStats: Object.fromEntries(dailyStats),
      };
      await writeFile(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      // نتجاهل أخطاء الكتابة حتى لا يتعطل البوت
    }
  }, 500);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

// ============================================================
// الحد اليومي
// ============================================================

function todayKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function getDailyStat(chatId) {
  const today = todayKey();
  const stat = dailyStats.get(chatId);
  if (!stat || stat.date !== today) {
    const fresh = { date: today, count: 0 };
    dailyStats.set(chatId, fresh);
    return fresh;
  }
  return stat;
}

// ============================================================
// إنشاء جلسة الرقم (مع فولباك بين المزودين)
// ============================================================

async function acquireNumber(chatId, country) {
  const providers = providerOrder();
  let lastError = null;

  for (const provider of providers) {
    try {
      let account;
      if (provider === 'sms-receive') account = await pickSmsReceiveNumber(country);
      else if (provider === 'receive-smss') account = await pickReceiveSmssNumber(country);
      else if (provider === 'quackr') account = await pickQuackrNumber(country);
      else continue;

      const stat = getDailyStat(chatId);
      stat.count += 1;

      const session = {
        provider: account.provider,
        country: country.code,
        countryLabel: country.label,
        countryFlag: country.flag,
        number: account.number,
        url: account.url,
        createdAt: Date.now(),
        dailyCount: stat.count,
        lastResetDate: stat.date,
        messages: [],
      };

      userSessions.set(chatId, session);
      await persistStorage();
      return session;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('تعذر الحصول على رقم من أي مزود');
}

// جلب رسائل الجلسة الحالية عبر المزود المناسب
async function fetchMessages(session) {
  if (session.provider === 'sms-receive') return fetchSmsReceiveMessages(session);
  if (session.provider === 'receive-smss') return fetchReceiveSmssMessages(session);
  if (session.provider === 'quackr') return fetchQuackrMessages(session);
  return [];
}

// ============================================================
// نصوص الرسائل للمستخدم
// ============================================================

function newNumberText(session) {
  return [
    `📞 رقمك الجديد ${session.countryFlag}`,
    `🌍 الدولة: ${session.countryLabel}`,
    `📱 الرقم: ${session.number}`,
    `🔌 المزود: ${providerLabel(session.provider)}`,
    '⏱️ صالح لمدة: 24 ساعة',
    '📬 لفحص الرسائل: /check',
    `📊 الحد اليومي: ${session.dailyCount}/${DAILY_SMS_LIMIT}`,
  ].join('\n');
}

function inboxText(session, messages) {
  if (messages.length === 0) {
    return [
      `📭 لا توجد رسائل حالياً على ${session.number}`,
      'انتظر قليلاً ثم جرب /check مرة ثانية.',
    ].join('\n');
  }

  const lines = [
    `📬 رسائل ${session.number} (${messages.length}):`,
    '',
  ];
  messages.forEach((message, index) => {
    const preview = truncate(message.body, 200).replace(/\n/g, ' ');
    lines.push(`${index + 1}) من: ${message.from}`);
    if (message.date) lines.push(`   التاريخ: ${message.date}`);
    lines.push(`   المحتوى: ${preview}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

function countriesMenuText() {
  return [
    '🌍 اختر دولة للحصول على رقم وهمي:',
    '',
    '🇺🇸 /numberus - الولايات المتحدة',
    '🇬🇧 /numberuk - المملكة المتحدة',
    '🇸🇦 /numbersa - السعودية',
    '',
    'أوامر مساعدة:',
    '/check - فحص الرسائل الواردة',
    '/mynumber - عرض رقمك الحالي',
    '/clearnumber - حذف رقمك الحالي',
  ].join('\n');
}

// ============================================================
// الأوامر
// ============================================================

// /number : قائمة الدول
export async function handleNumberMenu(ctx) {
  try {
    await ensureStorageLoaded();
    return await ctx.reply(countriesMenuText());
  } catch (error) {
    return await ctx.reply('عذراً، صار خطأ. حاول مرة ثانية.');
  }
}

// دالة عامة لإصدار رقم لدولة محددة (تستدعى من /numberus و /numberuk و /numbersa)
export function handleNumberForCountry(countryCode) {
  return async (ctx) => {
    try {
      await ensureStorageLoaded();
      const country = getCountry(countryCode);
      if (!country) {
        return await ctx.reply('عذراً، هذه الدولة غير مدعومة.');
      }

      const chatId = ctx.chat.id;
      const existing = userSessions.get(chatId);

      // إذا عنده رقم فعّال نعرضه بدون استهلاك الحد
      if (existing && Date.now() - (existing.createdAt ?? 0) < SESSION_TTL_MS) {
        return await ctx.reply(
          [
            '📞 عندك رقم فعال حالياً',
            `📱 الرقم: ${existing.number}`,
            `${existing.countryFlag} الدولة: ${existing.countryLabel}`,
            '📬 لفحص الرسائل: /check',
            '🗑️ لحذفه والحصول على غيره: /clearnumber',
          ].join('\n')
        );
      }

      // فحص الحد اليومي
      const stat = getDailyStat(chatId);
      if (stat.count >= DAILY_SMS_LIMIT) {
        return await ctx.reply(`⚠️ استهلكت الحد اليومي (${DAILY_SMS_LIMIT} أرقام)، حاول غداً.`);
      }

      await ctx.sendChatAction('typing').catch(() => {});
      const session = await acquireNumber(chatId, country);
      return await ctx.reply(newNumberText(session));
    } catch (error) {
      return await ctx.reply(
        'عذراً، ما قدرت أجيب لك رقم من هذه الدولة الآن. جرب دولة ثانية أو حاول لاحقاً.'
      );
    }
  };
}

// /check : فحص الرسائل على الرقم الحالي
export async function handleCheck(ctx) {
  try {
    await ensureStorageLoaded();
    const chatId = ctx.chat.id;
    const session = userSessions.get(chatId);
    if (!session) {
      return await ctx.reply('ما عندك رقم حالياً. اختر دولة أولاً: /number');
    }

    // انتهت صلاحية الرقم
    if (Date.now() - (session.createdAt ?? 0) > SESSION_TTL_MS) {
      userSessions.delete(chatId);
      await persistStorage();
      return await ctx.reply('⏱️ انتهت صلاحية رقمك (24 ساعة). أنشئ رقماً جديداً: /number');
    }

    await ctx.sendChatAction('typing').catch(() => {});
    const messages = await fetchMessages(session);
    session.messages = messages;
    await persistStorage();
    return await ctx.reply(inboxText(session, messages));
  } catch (error) {
    return await ctx.reply('عذراً، ما قدرت أفحص الرسائل الآن. حاول بعد قليل.');
  }
}

// /mynumber : عرض الرقم الحالي
export async function handleMyNumber(ctx) {
  try {
    await ensureStorageLoaded();
    const session = userSessions.get(ctx.chat.id);
    if (!session) {
      return await ctx.reply('ما عندك رقم حالياً. اختر دولة: /number');
    }

    return await ctx.reply(
      [
        '📞 رقمك الحالي',
        `📱 الرقم: ${session.number}`,
        `${session.countryFlag} الدولة: ${session.countryLabel}`,
        `🔌 المزود: ${providerLabel(session.provider)}`,
        `📊 الحد اليومي: ${session.dailyCount}/${DAILY_SMS_LIMIT}`,
        '📬 لفحص الرسائل: /check',
      ].join('\n')
    );
  } catch (error) {
    return await ctx.reply('عذراً، ما قدرت أعرض رقمك.');
  }
}

// /clearnumber : حذف الرقم الحالي
export async function handleClearNumber(ctx) {
  try {
    await ensureStorageLoaded();
    const chatId = ctx.chat.id;
    const session = userSessions.get(chatId);
    if (!session) {
      return await ctx.reply('ما عندك رقم حالياً لحذفه. للحصول على واحد: /number');
    }

    userSessions.delete(chatId);
    await persistStorage();
    return await ctx.reply('🗑️ تم حذف رقمك. للحصول على رقم جديد: /number');
  } catch (error) {
    return await ctx.reply('عذراً، صار خطأ أثناء حذف الرقم.');
  }
}

// ============================================================
// التنظيف التلقائي
// ============================================================

let cleanupTimer = null;

export function startSmsCleanupTimer() {
  if (cleanupTimer) return cleanupTimer;

  // نضمن تحميل التخزين عند بدء المؤقّت
  ensureStorageLoaded().catch(() => {});

  cleanupTimer = setInterval(async () => {
    const now = Date.now();
    let changed = false;

    for (const [chatId, session] of userSessions) {
      if (now - (session.createdAt ?? 0) > SESSION_TTL_MS) {
        userSessions.delete(chatId);
        changed = true;
      }
    }

    const today = todayKey();
    for (const [chatId, stat] of dailyStats) {
      if (stat.date !== today) {
        dailyStats.delete(chatId);
        changed = true;
      }
    }

    if (changed) await persistStorage();
  }, CLEANUP_INTERVAL_MS);

  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
  return cleanupTimer;
}
