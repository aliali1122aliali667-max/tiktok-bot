import 'dotenv/config';

// ============================================================
// إعدادات عامة
// ============================================================

const MAIL_TM_BASE = 'https://api.mail.tm';
const SEC_MAIL_BASE = 'https://www.1secmail.com/api/v1/';

// مهلة الطلب بالمللي ثانية حتى لا يتعلق البوت
const REQUEST_TIMEOUT_MS = 15000;

// مدة صلاحية الجلسة (24 ساعة) وفترة التنظيف (ساعة)
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// الحد اليومي لإنشاء الإيميلات لكل مستخدم
const DEFAULT_DAILY_EMAIL_LIMIT = 10;
const DAILY_EMAIL_LIMIT =
  Number.parseInt(process.env.DAILY_EMAIL_LIMIT ?? '', 10) || DEFAULT_DAILY_EMAIL_LIMIT;

// ترتيب المزودين: الأساسي ثم الاحتياطي
function normalizeProvider(value) {
  const name = String(value ?? '').trim().toLowerCase();
  if (name === 'mailtm' || name === 'mail.tm') return 'mailtm';
  if (name === '1secmail' || name === 'secmail' || name === '1sec') return '1secmail';
  return '';
}

const PROVIDER_PRIMARY = normalizeProvider(process.env.EMAIL_PROVIDER_PRIMARY) || 'mailtm';
const PROVIDER_FALLBACK = normalizeProvider(process.env.EMAIL_PROVIDER_FALLBACK) || '1secmail';

function providerOrder() {
  return [...new Set([PROVIDER_PRIMARY, PROVIDER_FALLBACK].filter(Boolean))];
}

function providerLabel(provider) {
  if (provider === 'mailtm') return 'mail.tm';
  if (provider === '1secmail') return '1secmail';
  return provider ?? 'غير معروف';
}

// ============================================================
// تخزين جلسات المستخدمين
// ============================================================

// جلسات المستخدمين: المفتاح هو معرف المحادثة (chat id)
const userSessions = new Map();

// إحصاءات الحد اليومي، تبقى محفوظة حتى بعد حذف الإيميل
const dailyStats = new Map();

// ============================================================
// أدوات مساعدة عامة
// ============================================================

// طلب HTTP موحّد فوق fetch مع مهلة ومعالجة أخطاء
async function httpRequest(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();

    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }

    if (!response.ok) {
      const message =
        data && typeof data === 'object'
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

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()-_=+';

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function pickRandom(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[randomInt(list.length)];
}

function randomChars(length, alphabet) {
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += alphabet[randomInt(alphabet.length)];
  }
  return result;
}

function shuffle(value) {
  const chars = value.split('');
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// الجزء المحلي من الإيميل: 10 أحرف (حروف صغيرة + أرقام)
function randomLocalPart(length = 10) {
  return randomChars(length, LOWERCASE + DIGITS);
}

// كلمة مرور: 12 حرفاً (كبيرة + صغيرة + أرقام + رموز) مع ضمان وجود نوع من كل مجموعة
function generatePassword(length = 12) {
  const required = [
    UPPERCASE[randomInt(UPPERCASE.length)],
    LOWERCASE[randomInt(LOWERCASE.length)],
    DIGITS[randomInt(DIGITS.length)],
    SYMBOLS[randomInt(SYMBOLS.length)],
  ];
  const rest = randomChars(length - required.length, UPPERCASE + LOWERCASE + DIGITS + SYMBOLS);
  return shuffle(required.join('') + rest);
}

function splitEmail(email) {
  const at = String(email ?? '').lastIndexOf('@');
  if (at <= 0) return { login: '', domain: '' };
  return { login: email.slice(0, at), domain: email.slice(at + 1) };
}

// تحويل HTML إلى نص عادي بشكل مبسّط
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(text, max = 3500) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}\n...(تم اختصار الرسالة)` : value;
}

// ============================================================
// دوال mail.tm
// ============================================================

// جلب الدومينات المتاحة من mail.tm
export async function getMailTmDomains() {
  const data = await httpRequest(`${MAIL_TM_BASE}/domains?page=1`);
  const members = Array.isArray(data?.['hydra:member']) ? data['hydra:member'] : [];
  return members
    .filter((item) => item && item.isActive !== false && item.isPrivate !== true)
    .map((item) => item.domain)
    .filter(Boolean);
}

// إنشاء حساب جديد في mail.tm
export async function createMailTmAccount(address, password) {
  return httpRequest(`${MAIL_TM_BASE}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
}

// جلب توكن الدخول من mail.tm
export async function getMailTmToken(address, password) {
  return httpRequest(`${MAIL_TM_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
}

// جلب رسائل الصندوق من mail.tm
export async function getMailTmInbox(token) {
  const data = await httpRequest(`${MAIL_TM_BASE}/messages`, { headers: authHeaders(token) });
  return Array.isArray(data?.['hydra:member']) ? data['hydra:member'] : [];
}

// قراءة رسالة واحدة من mail.tm
export async function readMailTmMessage(token, id) {
  return httpRequest(`${MAIL_TM_BASE}/messages/${encodeURIComponent(id)}`, {
    headers: authHeaders(token),
  });
}

// حذف حساب mail.tm
export async function deleteMailTmAccount(token, id) {
  return httpRequest(`${MAIL_TM_BASE}/accounts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}

// ============================================================
// دوال 1secmail (الاحتياطي)
// ============================================================

// جلب الدومينات المتاحة من 1secmail
export async function getSecMailDomains() {
  const data = await httpRequest(`${SEC_MAIL_BASE}?action=getDomainList`);
  return Array.isArray(data) ? data : [];
}

// إنشاء إيميل عشوائي محلياً عبر 1secmail
export async function createSecMailAccount(domains = null) {
  const list = domains ?? (await getSecMailDomains());
  const domain = pickRandom(list);
  if (!domain) throw new Error('لا يوجد دومين متاح في 1secmail');
  return {
    provider: '1secmail',
    email: `${randomLocalPart()}@${domain}`,
    password: generatePassword(),
    token: null,
    id: null,
  };
}

// جلب رسائل الصندوق من 1secmail
export async function getSecMailInbox(email) {
  const { login, domain } = splitEmail(email);
  const url =
    `${SEC_MAIL_BASE}?action=getMessages` +
    `&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}`;
  const data = await httpRequest(url);
  return Array.isArray(data) ? data : [];
}

// قراءة رسالة واحدة من 1secmail
export async function readSecMailMessage(email, id) {
  const { login, domain } = splitEmail(email);
  const url =
    `${SEC_MAIL_BASE}?action=readMessage` +
    `&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}` +
    `&id=${encodeURIComponent(id)}`;
  return httpRequest(url);
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

// يرجع إحصاء اليوم الحالي للمستخدم ويعيد التصفير عند تغيّر التاريخ
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

// مزامنة عدّاد الجلسة مع إحصاء اليوم
function resetDailyIfNeeded(session) {
  if (!session) return;
  const today = todayKey();
  if (session.lastResetDate !== today) {
    session.lastResetDate = today;
    session.dailyEmailCount = 0;
  }
}

// ============================================================
// إنشاء الجلسات وقراءة الرسائل
// ============================================================

// إنشاء جلسة عبر mail.tm
async function createMailTmSession() {
  const domains = await getMailTmDomains();
  const domain = pickRandom(domains);
  if (!domain) throw new Error('لا يوجد دومين متاح في mail.tm');

  const email = `${randomLocalPart()}@${domain}`;
  const password = generatePassword();

  const account = await createMailTmAccount(email, password);
  const auth = await getMailTmToken(email, password);
  if (!auth?.token) throw new Error('تعذر الحصول على توكن mail.tm');

  return {
    provider: 'mailtm',
    email: account?.address ?? email,
    password,
    token: auth.token,
    id: auth.id ?? account?.id ?? null,
  };
}

// إنشاء جلسة عبر 1secmail
async function createSecMailSession() {
  const account = await createSecMailAccount();
  return {
    provider: account.provider,
    email: account.email,
    password: account.password,
    token: null,
    id: null,
  };
}

// تجربة المزودين بالترتيب (الأساسي ثم الاحتياطي) حتى ينجح أحدهم
async function createTemporaryEmail(chatId) {
  const providers = providerOrder();
  let lastError = null;

  for (const provider of providers) {
    try {
      const account = provider === 'mailtm' ? await createMailTmSession() : await createSecMailSession();
      const stat = getDailyStat(chatId);
      stat.count += 1;

      const session = {
        provider: account.provider,
        email: account.email,
        password: account.password,
        token: account.token,
        id: account.id,
        createdAt: Date.now(),
        dailyEmailCount: stat.count,
        lastResetDate: stat.date,
        messages: [],
      };

      userSessions.set(chatId, session);
      return session;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('تعذر إنشاء إيميل مؤقت');
}

// جلب قائمة الرسائل بشكل موحّد حسب المزود
async function fetchInboxMessages(session) {
  if (session.provider === 'mailtm') {
    const raw = await getMailTmInbox(session.token);
    return raw.map((message) => ({
      id: message.id,
      from: message.from?.address ?? message.from?.name ?? 'مجهول',
      subject: message.subject || '(بدون موضوع)',
      date: message.createdAt ?? '',
    }));
  }

  const raw = await getSecMailInbox(session.email);
  return raw.map((message) => ({
    id: message.id,
    from: message.from || 'مجهول',
    subject: message.subject || '(بدون موضوع)',
    date: message.date ?? '',
  }));
}

// قراءة رسالة واحدة بشكل موحّد حسب المزود
async function readMessage(session, id) {
  if (session.provider === 'mailtm') {
    const message = await readMailTmMessage(session.token, id);
    return {
      from: message?.from?.address ?? message?.from?.name ?? 'مجهول',
      subject: message?.subject || '(بدون موضوع)',
      body: message?.text || htmlToText(message?.html),
    };
  }

  const message = await readSecMailMessage(session.email, id);
  return {
    from: message?.from || 'مجهول',
    subject: message?.subject || '(بدون موضوع)',
    body: message?.textBody || htmlToText(message?.htmlBody || message?.body),
  };
}

// ============================================================
// نصوص الرسائل
// ============================================================

function newEmailText(session, count) {
  return [
    '📧 إيميلك الجديد',
    `📮 العنوان: ${session.email}`,
    `🔑 كلمة المرور: ${session.password}`,
    '⏱️ صالح لمدة: 24 ساعة',
    '📬 للاطلاع: /inbox',
    `📊 الحد اليومي: ${count}/${DAILY_EMAIL_LIMIT}`,
  ].join('\n');
}

function inboxText(messages) {
  const lines = [`📬 صندوق الوارد (${messages.length}):`, ''];
  messages.forEach((message, index) => {
    lines.push(`${index + 1} - ${message.from} - ${message.subject}`);
  });
  lines.push('', 'لقراءة رسالة: /read <رقم>');
  return lines.join('\n');
}

// ============================================================
// الأوامر
// ============================================================

// /email : إنشاء إيميل مؤقت جديد
export async function handleEmail(ctx) {
  try {
    const chatId = ctx.chat.id;
    const existing = userSessions.get(chatId);

    // إذا عنده إيميل حالياً نعرضه له بدون استهلاك الحد
    if (existing) {
      resetDailyIfNeeded(existing);
      return await ctx.reply(
        [
          '📧 عندك إيميل مؤقت حالياً',
          `📮 العنوان: ${existing.email}`,
          '📬 للاطلاع على الرسائل: /inbox',
        ].join('\n')
      );
    }

    // فحص الحد اليومي
    const stat = getDailyStat(chatId);
    if (stat.count >= DAILY_EMAIL_LIMIT) {
      return await ctx.reply(`⚠️ استهلكت الحد اليومي (${DAILY_EMAIL_LIMIT} إيميلات)، حاول غداً`);
    }

    const session = await createTemporaryEmail(chatId);
    return await ctx.reply(newEmailText(session, stat.count));
  } catch (error) {
    return await ctx.reply('عذراً، ما قدرت أنشئ إيميل مؤقت حالياً. حاول بعد قليل.');
  }
}

// /inbox : عرض رسائل الصندوق
export async function handleInbox(ctx) {
  try {
    const chatId = ctx.chat.id;
    const session = userSessions.get(chatId);
    if (!session) {
      return await ctx.reply('ما عندك إيميل مؤقت. أنشئ إيميل أولاً: /email');
    }

    await ctx.sendChatAction('typing').catch(() => {});
    const messages = await fetchInboxMessages(session);
    session.messages = messages;

    if (messages.length === 0) {
      return await ctx.reply('📭 لا توجد رسائل');
    }
    return await ctx.reply(inboxText(messages));
  } catch (error) {
    return await ctx.reply('عذراً، ما قدرت أجلب الرسائل الآن. جرب /refresh');
  }
}

// /read <n> : قراءة رسالة بالرقم
export async function handleRead(ctx) {
  try {
    const chatId = ctx.chat.id;
    const session = userSessions.get(chatId);
    if (!session) {
      return await ctx.reply('ما عندك إيميل مؤقت. أنشئ إيميل أولاً: /email');
    }

    const argument = String(ctx.message?.text ?? '')
      .replace(/^\/read(@\w+)?/i, '')
      .trim();
    const index = Number.parseInt(argument, 10);
    if (!Number.isInteger(index)) {
      return await ctx.reply('الاستخدام: /read 1');
    }

    let messages = session.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      messages = await fetchInboxMessages(session);
      session.messages = messages;
    }

    if (index < 1 || index > messages.length) {
      return await ctx.reply(`ما لقيت رسالة بهذا الرقم. عندك ${messages.length} رسالة حالياً.`);
    }

    const message = await readMessage(session, messages[index - 1].id);
    const body = message.body ? truncate(message.body) : '(لا يوجد محتوى)';
    return await ctx.reply(
      [`📨 من: ${message.from}`, `📝 الموضوع: ${message.subject}`, '', body].join('\n')
    );
  } catch (error) {
    return await ctx.reply('عذراً، ما قدرت أقرأ هذه الرسالة. جرب /refresh ثم /read مرة ثانية.');
  }
}

// /refresh : تحديث الرسائل (نفس /inbox)
export async function handleRefresh(ctx) {
  return handleInbox(ctx);
}

// /delete : حذف الإيميل الحالي
export async function handleDelete(ctx) {
  try {
    const chatId = ctx.chat.id;
    const session = userSessions.get(chatId);
    if (!session) {
      return await ctx.reply('ما عندك إيميل مؤقت لحذفه. للإنشاء: /email');
    }

    // حذف الحساب من المزود إن كان يدعم ذلك
    if (session.provider === 'mailtm' && session.token && session.id) {
      await deleteMailTmAccount(session.token, session.id).catch(() => {});
    }

    userSessions.delete(chatId);
    return await ctx.reply('🗑️ تم حذف إيميلك');
  } catch (error) {
    return await ctx.reply('عذراً، صار خطأ أثناء حذف الإيميل. حاول مرة ثانية.');
  }
}

// /myemail : عرض الإيميل الحالي
export async function handleMyEmail(ctx) {
  try {
    const session = userSessions.get(ctx.chat.id);
    if (!session) {
      return await ctx.reply('ما عندك إيميل مؤقت حالياً. أنشئ واحد: /email');
    }

    resetDailyIfNeeded(session);
    return await ctx.reply(
      [
        '📧 إيميلك الحالي',
        `📮 العنوان: ${session.email}`,
        `🔌 المزود: ${providerLabel(session.provider)}`,
        `📊 الحد اليومي: ${session.dailyEmailCount}/${DAILY_EMAIL_LIMIT}`,
        '📬 للاطلاع على الرسائل: /inbox',
      ].join('\n')
    );
  } catch (error) {
    return await ctx.reply('عذراً، ما قدرت أعرض إيميلك الحالي.');
  }
}

// ============================================================
// التنظيف التلقائي
// ============================================================

let cleanupTimer = null;

// بدء مؤقّت التنظيف: يحذف الجلسات الأقدم من 24 ساعة كل ساعة
export function startCleanupTimer() {
  if (cleanupTimer) return cleanupTimer;

  cleanupTimer = setInterval(() => {
    const now = Date.now();

    for (const [chatId, session] of userSessions) {
      if (now - (session.createdAt ?? 0) > SESSION_TTL_MS) {
        userSessions.delete(chatId);
      }
    }

    const today = todayKey();
    for (const [chatId, stat] of dailyStats) {
      if (stat.date !== today) {
        dailyStats.delete(chatId);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // لا نمنع إغلاق العملية بسبب هذا المؤقّت
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

  return cleanupTimer;
}
