// نظام المشرفين وأوامر الإحصائيات الخاصة بهم.
// المشرفون يُعرّفون عبر ADMIN_IDS في ملف .env مفصولة بفواصل.

import 'dotenv/config';
import {
  getActiveToday,
  getStats,
  getTopUsers,
  getUserInfo,
  getUsersList,
} from './stats.js';

// قائمة معرّفات المشرفين (تُقرأ مرة واحدة عند الإقلاع).
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

const MAX_MESSAGE_LENGTH = 3800;

// هل المستخدم مشرف؟
export function isAdmin(userId) {
  if (userId === undefined || userId === null) return false;
  return ADMIN_IDS.has(String(userId));
}

// ميدل وير يمنع غير المشرفين من استخدام أوامر الإدارة.
export function adminOnly(ctx, next) {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.reply('⛔ هذا الأمر للمشرفين فقط');
  }
  return next();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

// تنسيق التاريخ بالشكل YYYY-MM-DD.
function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// تنسيق التاريخ والوقت بالشكل YYYY-MM-DD HH:mm.
function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${formatDate(iso)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fullName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'بدون اسم';
}

// إرسال نص طويل مقسّم على عدة رسائل لتجاوز حد تيليجرام.
async function sendLong(ctx, text) {
  const lines = text.split('\n');
  const chunks = [];
  let chunk = '';

  for (const line of lines) {
    if (chunk && `${chunk}\n${line}`.length > MAX_MESSAGE_LENGTH) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) chunks.push(chunk);

  for (const part of chunks) {
    await ctx.reply(part);
  }
}

// /stats - إحصائيات عامة شاملة.
export async function handleStats(ctx) {
  const stats = getStats();
  const lines = [
    '📊 إحصائيات البوت',
    '',
    `👥 إجمالي المستخدمين: ${formatNumber(stats.totalUsers)}`,
    `🟢 نشطين اليوم: ${formatNumber(stats.activeToday)}`,
    `📅 نشطين هذا الأسبوع: ${formatNumber(stats.activeLast7Days)}`,
    '',
    `💬 إجمالي الرسائل: ${formatNumber(stats.totalMessages)}`,
    `🎬 فيديوهات منزلة: ${formatNumber(stats.totalVideos)}`,
    `📧 إيميلات منشأة: ${formatNumber(stats.totalEmails)}`,
  ];

  const topCommands = stats.topCommands.slice(0, 5);
  if (topCommands.length) {
    lines.push('', '🔥 أكثر الأوامر استخداماً:');
    topCommands.forEach((command, index) => {
      lines.push(`${index + 1}. ${command.name} - ${formatNumber(command.count)} مرة`);
    });
  }

  lines.push('', `⏱️ آخر تحديث: ${formatDateTime(stats.lastUpdated ?? new Date().toISOString())}`);
  return sendLong(ctx, lines.join('\n'));
}

// /users - قائمة كل المستخدمين (مرقمة).
export async function handleUsers(ctx) {
  const users = getUsersList();
  if (!users.length) {
    return ctx.reply('لا يوجد مستخدمون مسجلون بعد.');
  }

  const lines = [`👥 قائمة المستخدمين (${formatNumber(users.length)}):`, ''];
  users.forEach((user, index) => {
    const handle = user.username ? ` (@${user.username})` : '';
    lines.push(
      `${index + 1}. ${fullName(user)}${handle} — ID: ${user.id} — 💬 ${formatNumber(user.messageCount)}`
    );
  });

  return sendLong(ctx, lines.join('\n'));
}

// /user <id> - معلومات مستخدم محدد.
export async function handleUser(ctx) {
  const rawId = ctx.message.text.replace(/^\/user(@\w+)?/i, '').trim();
  if (!rawId) {
    return ctx.reply('الاستخدام: /user <معرّف المستخدم>');
  }

  const user = getUserInfo(rawId);
  if (!user) {
    return ctx.reply(`لا يوجد مستخدم بالمعرّف: ${rawId}`);
  }

  const lines = [
    '👤 معلومات المستخدم',
    '',
    `🆔 ID: ${user.id}`,
    `📛 الاسم: ${fullName(user)}`,
    `🔗 Username: ${user.username ? `@${user.username}` : '—'}`,
    '',
    `📅 أول ظهور: ${formatDate(user.firstSeen)}`,
    `⏰ آخر ظهور: ${formatDateTime(user.lastSeen)}`,
    '',
    `💬 الرسائل: ${formatNumber(user.messageCount)}`,
    `🎬 فيديوهات: ${formatNumber(user.videoCount)}`,
    `📧 إيميلات: ${formatNumber(user.emailCount)}`,
  ];

  return sendLong(ctx, lines.join('\n'));
}

// /active - المستخدمون النشطون اليوم.
export async function handleActive(ctx) {
  const users = getActiveToday();
  if (!users.length) {
    return ctx.reply('لا يوجد مستخدمون نشطون اليوم.');
  }

  const lines = [`🟢 المستخدمون النشطون اليوم (${formatNumber(users.length)}):`, ''];
  users.forEach((user, index) => {
    lines.push(
      `${index + 1}. ${fullName(user)} — ID: ${user.id} — ⏰ ${formatDateTime(user.lastSeen)}`
    );
  });

  return sendLong(ctx, lines.join('\n'));
}

// /top - أكثر 10 مستخدمين استخداماً.
export async function handleTop(ctx) {
  const users = getTopUsers(10);
  if (!users.length) {
    return ctx.reply('لا يوجد مستخدمون بعد.');
  }

  const lines = ['🏆 أكثر 10 مستخدمين استخداماً:', ''];
  users.forEach((user, index) => {
    lines.push(
      `${index + 1}. ${fullName(user)} — 💬 ${formatNumber(user.messageCount)} | 🎬 ${formatNumber(user.videoCount)} | 📧 ${formatNumber(user.emailCount)} | ⚙️ ${formatNumber(user.commandCount)}`
    );
  });

  return sendLong(ctx, lines.join('\n'));
}
