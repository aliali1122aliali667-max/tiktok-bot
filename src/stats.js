// نظام إحصائيات المستخدمين
// يتابع كل من يستخدم البوت ويحفظ البيانات في ملف JSON محلي.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// جذر المشروع، لضمان أن مسار ملف الإحصائيات مستقل عن مجلد التشغيل.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// مسار ملف الحفظ: STATS_FILE من .env أو data/stats.json افتراضياً.
function resolveStatsFile() {
  const raw = (process.env.STATS_FILE ?? '').trim() || 'data/stats.json';
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

// الفاصل الزمني للحفظ الدوري (افتراضياً كل دقيقة) لتفادي فقدان البيانات.
function resolveSaveInterval() {
  const parsed = Number.parseInt((process.env.SAVE_INTERVAL_MS ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
}

export const statsFilePath = resolveStatsFile();
const SAVE_INTERVAL_MS = resolveSaveInterval();

// الحالة الداخلية محفوظة في الذاكرة باستخدام Map.
const state = {
  users: new Map(),
  commands: new Map(),
  totals: { messages: 0, videos: 0, emails: 0 },
  lastUpdated: null,
  dirty: false,
};

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

// قالب مستخدم جديد فارغ.
function emptyUser(userId) {
  const now = new Date().toISOString();
  return {
    id: String(userId),
    firstName: '',
    lastName: '',
    username: '',
    firstSeen: now,
    lastSeen: now,
    messageCount: 0,
    videoCount: 0,
    emailCount: 0,
    commandCount: 0,
  };
}

// يجلب المستخدم من الذاكرة أو ينشئه إن لم يكن موجوداً.
function getOrCreateUser(userId) {
  const id = String(userId);
  let user = state.users.get(id);
  if (!user) {
    user = emptyUser(id);
    state.users.set(id, user);
    state.dirty = true;
  }
  return user;
}

// يوحّد اسم الأمر: يزيل الشرطة المائلة واللاحقة @BotName ويحوّله لحروف صغيرة.
function normalizeCommand(commandName) {
  const clean = String(commandName ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/@.*$/, '')
    .toLowerCase();
  return clean ? `/${clean}` : '';
}

function isSameLocalDay(date, reference) {
  return (
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate()
  );
}

// ترتيب نشاط المستخدم الإجمالي (رسائل + أوامر + فيديوهات + إيميلات).
function activityScore(user) {
  return user.messageCount + user.commandCount + user.videoCount + user.emailCount;
}

function serialize() {
  return {
    users: Object.fromEntries(state.users),
    commands: Object.fromEntries(state.commands),
    totals: state.totals,
    lastUpdated: state.lastUpdated,
  };
}

// قراءة البيانات عند بدء البوت.
function loadStats() {
  try {
    if (!fs.existsSync(statsFilePath)) return;
    const parsed = JSON.parse(fs.readFileSync(statsFilePath, 'utf8'));

    if (parsed.users && typeof parsed.users === 'object') {
      for (const [id, stored] of Object.entries(parsed.users)) {
        state.users.set(String(id), { ...emptyUser(id), ...stored, id: String(id) });
      }
    }

    if (parsed.commands && typeof parsed.commands === 'object') {
      for (const [name, count] of Object.entries(parsed.commands)) {
        state.commands.set(name, Number(count) || 0);
      }
    }

    if (parsed.totals && typeof parsed.totals === 'object') {
      state.totals.messages = Number(parsed.totals.messages) || 0;
      state.totals.videos = Number(parsed.totals.videos) || 0;
      state.totals.emails = Number(parsed.totals.emails) || 0;
    }

    state.lastUpdated = parsed.lastUpdated ?? null;
    log(`تم تحميل إحصائيات ${state.users.size} مستخدم من ${statsFilePath}`);
  } catch (error) {
    log(`تعذر قراءة ملف الإحصائيات: ${error.message}`);
  }
}

// حفظ البيانات على القرص (كتابة ذرّية عبر ملف مؤقت ثم إعادة التسمية).
export function saveStats() {
  if (!state.dirty) return;
  try {
    fs.mkdirSync(path.dirname(statsFilePath), { recursive: true });
    state.lastUpdated = new Date().toISOString();
    const tmpFile = `${statsFilePath}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(serialize(), null, 2), 'utf8');
    fs.renameSync(tmpFile, statsFilePath);
    state.dirty = false;
  } catch (error) {
    log(`فشل حفظ الإحصائيات: ${error.message}`);
  }
}

// تشغيل الحفظ الدوري كل SAVE_INTERVAL_MS.
export function startStatsTimer() {
  const timer = setInterval(saveStats, SAVE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

// ============================================================
// دوال التتبع
// ============================================================

// تسجيل/تحديث مستخدم من سياق Telegraf (ctx.from).
export function trackUser(ctx) {
  const from = ctx?.from;
  if (!from?.id) return null;

  const user = getOrCreateUser(from.id);
  const now = new Date().toISOString();
  user.firstName = from.first_name ?? user.firstName ?? '';
  user.lastName = from.last_name ?? user.lastName ?? '';
  user.username = from.username ?? user.username ?? '';
  user.lastSeen = now;
  if (!user.firstSeen) user.firstSeen = now;

  state.dirty = true;
  return user;
}

// تسجيل رسالة نصية.
export function trackMessage(userId) {
  if (!userId) return;
  const user = getOrCreateUser(userId);
  user.messageCount += 1;
  user.lastSeen = new Date().toISOString();
  state.totals.messages += 1;
  state.dirty = true;
}

// تسجيل فيديو تم تنزيله بنجاح.
export function trackVideo(userId) {
  if (!userId) return;
  const user = getOrCreateUser(userId);
  user.videoCount += 1;
  user.lastSeen = new Date().toISOString();
  state.totals.videos += 1;
  state.dirty = true;
}

// تسجيل إيميل مؤقت تم إنشاؤه.
export function trackEmail(userId) {
  if (!userId) return;
  const user = getOrCreateUser(userId);
  user.emailCount += 1;
  user.lastSeen = new Date().toISOString();
  state.totals.emails += 1;
  state.dirty = true;
}

// تسجيل استخدام أمر معيّن.
export function trackCommand(userId, commandName) {
  const name = normalizeCommand(commandName);
  if (!name) return;

  state.commands.set(name, (state.commands.get(name) ?? 0) + 1);

  if (userId) {
    const user = getOrCreateUser(userId);
    user.commandCount += 1;
    user.lastSeen = new Date().toISOString();
  }

  state.dirty = true;
}

// ============================================================
// دوال الاستعلام
// ============================================================

// أكثر الأوامر استخداماً، مرتبة تنازلياً.
export function getTopCommands(limit = 5) {
  return [...state.commands.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

// إحصائيات عامة شاملة.
export function getStats() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  let activeToday = 0;
  let activeLast7Days = 0;

  for (const user of state.users.values()) {
    const lastSeen = new Date(user.lastSeen);
    if (Number.isNaN(lastSeen.getTime())) continue;
    if (isSameLocalDay(lastSeen, now)) activeToday += 1;
    if (lastSeen >= weekAgo) activeLast7Days += 1;
  }

  return {
    totalUsers: state.users.size,
    activeToday,
    activeLast7Days,
    totalMessages: state.totals.messages,
    totalVideos: state.totals.videos,
    totalEmails: state.totals.emails,
    topCommands: getTopCommands(10),
    lastUpdated: state.lastUpdated,
  };
}

// قائمة كل المستخدمين مرتبة حسب عدد الرسائل.
export function getUsersList() {
  return [...state.users.values()].sort(
    (a, b) => b.messageCount - a.messageCount || String(a.firstSeen).localeCompare(String(b.firstSeen))
  );
}

// معلومات مستخدم محدد.
export function getUserInfo(userId) {
  if (userId === undefined || userId === null) return null;
  return state.users.get(String(userId)) ?? null;
}

// المستخدمون النشطون اليوم.
export function getActiveToday() {
  const now = new Date();
  return [...state.users.values()]
    .filter((user) => {
      const lastSeen = new Date(user.lastSeen);
      return !Number.isNaN(lastSeen.getTime()) && isSameLocalDay(lastSeen, now);
    })
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

// أكثر المستخدمين استخداماً للبوت.
export function getTopUsers(limit = 10) {
  return [...state.users.values()]
    .sort((a, b) => activityScore(b) - activityScore(a) || b.messageCount - a.messageCount)
    .slice(0, limit);
}

// قراءة تلقائية عند استيراد الوحدة (بدء البوت).
loadStats();
