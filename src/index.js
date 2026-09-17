import { createServer } from 'node:http';
import { Telegraf, Markup } from 'telegraf';
import { config, isAIConfigured, TIKTOK_URL_PATTERN } from './config.js';
import { askAI, askAIWithImage, resetHistory } from './ai.js';
import { downloadTikTokVideo, normalizeTikTokUrl, removeFile } from './tiktok.js';
import { formatDecoratedNames } from './names.js';
import {
  applyImageFilter,
  fetchImage,
  filtersHelp,
  listFilters,
  resolveFilter,
  toDataUrl,
} from './image.js';
import { canGenerateImages, editImageWithGemini } from './image-ai.js';
import {
  handleEmail,
  handleInbox,
  handleRead,
  handleRefresh,
  handleDelete,
  handleMyEmail,
  startCleanupTimer,
} from './email.js';
import {
  handleNumberMenu,
  handleNumberForCountry,
  handleCheck,
  handleMyNumber,
  handleClearNumber,
  startSmsCleanupTimer,
} from './sms.js';
import {
  saveStats,
  startStatsTimer,
  trackCommand,
  trackEmail,
  trackMessage,
  trackUser,
  trackVideo,
} from './stats.js';
import {
  adminOnly,
  handleActive,
  handleStats,
  handleTop,
  handleUser,
  handleUsers,
} from './admin.js';
import { getMainKeyboard } from './keyboard.js';
const bot = new Telegraf(config.botToken);

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function extractTikTokUrl(text) {
  const match = text.match(TIKTOK_URL_PATTERN);
  return match ? normalizeTikTokUrl(match[0]) : null;
}

function getUserName(ctx) {
  const from = ctx.from ?? {};
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return (full || from.username || 'صديقي').slice(0, 60);
}

const FILTER_PREFIX = /^(?:فلتر|فلاتر|filter)\s*[:：]?\s*([\s\S]*)$/i;
const EDIT_PREFIX = /^(?:تعديل|عدّل|عدل|حلل|حلّلي|وصف|اشرح|edit|ai|analyze)\s*[:：]?\s*([\s\S]*)$/i;

function parseImageCaption(caption) {
  const text = (caption ?? '').trim();
  if (!text) return { type: 'none' };

  const filterMatch = text.match(FILTER_PREFIX);
  if (filterMatch) {
    const value = filterMatch[1].trim();
    return value ? { type: 'filter', value } : { type: 'help' };
  }

  const editMatch = text.match(EDIT_PREFIX);
  if (editMatch) {
    return { type: 'edit', value: editMatch[1].trim() };
  }

  return { type: 'edit', value: text };
}

function getImageFile(message) {
  if (!message) return null;
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return { fileId: largest.file_id, mime: 'image/jpeg' };
  }
  if (message.document && String(message.document.mime_type || '').startsWith('image/')) {
    return { fileId: message.document.file_id, mime: message.document.mime_type };
  }
  return null;
}

async function loadImage(ctx, file) {
  const link = await ctx.telegram.getFileLink(file.fileId);
  const { buffer, mime } = await fetchImage(link.href, config.download.timeoutMs);
  return { buffer, mime: file.mime || mime };
}

async function replaceStatus(ctx, statusMessage, text) {
  if (!statusMessage) return ctx.reply(text);
  return ctx.telegram
    .editMessageText(ctx.chat.id, statusMessage.message_id, undefined, text)
    .catch(() => {});
}

async function clearStatus(ctx, statusMessage) {
  if (!statusMessage) return;
  await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});
}

function imageHelpText(userName) {
  return [
    `${userName}، أقدر أساعدك بالصور بعدة طرق:`,
    '',
    '1) أرسل صورة واكتب التعليق: فلتر رمادي (أو أي فلتر من /filters).',
    '2) أرسل صورة مع تعليق فيه طلب تعديل، ليعدّلها الذكاء الاصطناعي إن كان المزود يدعم توليد الصور، وإلا يحللها ويجاوبك.',
    '   مثال: عدل هذه الصورة، أو: اشرح لي ما فيها.',
    '3) ردّ على صورة بأمر: /filter <اسم الفلتر>.',
    '',
    'لستة الفلاتر أرسل: /filters',
  ].join('\n');
}

const WELCOME = [
  'أهلاً بك! أقدر أساعدك في:',
  '',
  '1) تنزيل فيديوهات تيك توك - أرسل أي رابط تيك توك.',
  '2) الإجابة على أسئلتك بالذكاء الاصطناعي - أرسل أي رسالة.',
  '3) فلاتر الصور - أرسل صورة مع تعليق: فلتر رمادي.',
  '4) تعديل وتحليل الصور بالذكاء الاصطناعي - أرسل صورة مع طلبك.',
  '5) أسماء مزخرفة بالعربية والإنجليزية - /name اسمك.',
  '',
  'الأوامر:',
  '/start - رسالة الترحيب',
  '/help - طريقة الاستخدام',
  '/ai <سؤال> - سؤال مباشر للذكاء الاصطناعي',
  '/name <اسمك> - أسماء مزخرفة',
  '/filters - لستة فلاتر الصور',
  '/filter <اسم> - تطبيق فلتر على صورة بالردّ عليها',
  '/reset - حذف ذاكرة المحادثة',
].join('\n');

// ============================================================
// تتبع الأوامر: يسجّل المستخدم ويزيد عدّاد الأمر لكل أمر يُستخدم
// ============================================================
bot.use((ctx, next) => {
  const text = ctx.message?.text;
  if (typeof text === 'string' && text.startsWith('/')) {
    trackUser(ctx);
    const commandName = text.split(/\s+/)[0].slice(1).replace(/@.*$/, '');
    trackCommand(ctx.from?.id, commandName);
  }
  return next();
});

bot.sbot.start((ctx) =>
  ctx.reply(`أهلاً ${getUserName(ctx)}!\n\n${WELCOME}`, { ...getMainKeyboard() })
);

bot.help((ctx) =>
  ctx.reply(
    [
      `${getUserName(ctx)}، طريقة الاستخدام:`,
      '',
      'أرسل رابط فيديو تيك توك لينزل لك الفيديو.',
      'أو أرسل أي سؤال والذكاء الاصطناعي يجاوبك.',
      'أرسل صورة مع كلمة «فلتر <اسم>» لتطبيق فلتر، أو مع سؤالك ليحللها الذكاء الاصطناعي.',
      '',
      '/ai <سؤال> - سؤال مباشر للذكاء الاصطناعي',
      '/name <اسمك> - أسماء مزخرفة بالعربية والإنجليزية',
      '/filters - لستة فلاتر الصور',
      '/filter <اسم> - تطبيق فلتر على صورة بالردّ عليها',
      '/reset - حذف ذاكرة المحادثة',
    ].join('\n')
  )
);

bot.command('reset', (ctx) => {
  resetHistory(ctx.chat.id);
  return ctx.reply(`تم حذف ذاكرة المحادثة يا ${getUserName(ctx)}.`);
});

bot.command('ai', async (ctx) => {
  const prompt = ctx.message.text.replace(/^\/ai(@\w+)?/i, '').trim();
  if (!prompt) {
    return ctx.reply(`${getUserName(ctx)}، الاستخدام: /ai سؤالك`);
  }
  return handleAI(ctx, prompt);
});

bot.command(['name', 'names'], (ctx) => {
  const name = ctx.message.text.replace(/^\/names?(@\w+)?/i, '').trim();
  if (!name) {
    return ctx.reply(`${getUserName(ctx)}، اكتب اسمك بعد الأمر، مثال:\n/name محمد`);
  }
  const text = formatDecoratedNames(name);
  if (!text) {
    return ctx.reply(`${getUserName(ctx)}، اكتب اسماً صحيحاً بعد الأمر.`);
  }
  return ctx.reply(text);
});

bot.command('filters', (ctx) => ctx.reply(filtersHelp()));

bot.command('filter', async (ctx) => {
  const name = ctx.message.text.replace(/^\/filter(@\w+)?/i, '').trim();
  const source = getImageFile(ctx.message.reply_to_message);
  if (!source) {
    return ctx.reply(
      `${getUserName(ctx)}، ردّ على صورة بالأمر: /filter <اسم الفلتر>\nلستة الفلاتر: /filters`
    );
  }
  if (!name) {
    return ctx.reply(`${getUserName(ctx)}، اكتب اسم الفلتر بعد الأمر.\n${filtersHelp()}`);
  }
  return handleFilterOnImage(ctx, source, name, ctx.message.reply_to_message.message_id);
});

bot.command('image', (ctx) => ctx.reply(imageHelpText(getUserName(ctx))));

bot.command('email', async (ctx) => {
  const result = await handleEmail(ctx);
  trackEmail(ctx.from?.id);
  return result;
});
bot.command('inbox', handleInbox);
bot.command('read', handleRead);
bot.command('refresh', handleRefresh);
bot.command('delete', handleDelete);
bot.command('myemail', handleMyEmail);

// ============================================================
// أوامر الأرقام الوهمية
// ============================================================
bot.command('number', handleNumberMenu);
bot.command('numberus', handleNumberForCountry('us'));
bot.command('numberuk', handleNumberForCountry('uk'));
bot.command('numbersa', handleNumberForCountry('sa'));
bot.command('check', handleCheck);
bot.command('mynumber', handleMyNumber);
bot.command('clearnumber', handleClearNumber);

// ============================================================
// أوامر الإحصائيات (للمشرفين فقط - ADMIN_IDS في .env)
// ============================================================
bot.command('stats', adminOnly, handleStats);
bot.command('users', adminOnly, handleUsers);
bot.command('user', adminOnly, handleUser);
bot.command('active', adminOnly, handleActive);
bot.command('top', adminOnly, handleTop);

async function handleAI(ctx, prompt) {
  if (!isAIConfigured) {
    return ctx.reply(
      'الذكاء الاصطناعي غير مُهيأ. أضف USER_LLM_API_KEY في ملف .env ثم أعد التشغيل.'
    );
  }

  await ctx.sendChatAction('typing');
  try {
    const answer = await askAI(ctx.chat.id, prompt, getUserName(ctx));
    await ctx.reply(answer, {
      reply_parameters: { message_id: ctx.message.message_id },
    });
  } catch (error) {
    log(`AI error: ${error.message}`);
    await ctx.reply(
      `عذراً يا ${getUserName(ctx)}، خدمة الذكاء الاصطناعي غير متاحة حالياً. حاول لاحقاً.`
    );
  }
}

async function handleTikTok(ctx, url) {
  const userName = getUserName(ctx);
  const statusMessage = await ctx.reply(`${userName}، جاري تنزيل الفيديو، لحظة...`);
  let filePath = null;

  try {
    await ctx.sendChatAction('upload_video');
    const result = await downloadTikTokVideo(url);
    filePath = result.filePath;
    const sizeMb = result.sizeBytes / (1024 * 1024);

    if (sizeMb > config.download.maxSizeMb) {
      await replaceStatus(
        ctx,
        statusMessage,
        `${userName}، حجم الفيديو ${sizeMb.toFixed(1)} ميجابايت، وهذا أكبر من الحد المسموح للرفع في تيليجرام (${config.download.maxSizeMb} ميجابايت).`
      );
      return;
    }

    await ctx.replyWithVideo(
      { source: result.filePath },
      {
        caption: `تفضل يا ${userName}، هذا الفيديو.`,
        reply_parameters: { message_id: ctx.message.message_id },
      }
    );
    trackVideo(ctx.from?.id);
    await clearStatus(ctx, statusMessage);
  } catch (error) {
    log(`Download error: ${error.message}`);
    await replaceStatus(
      ctx,
      statusMessage,
      `${userName}، ما قدرت أنزل هذا الفيديو. تأكد أن الرابط صحيح وأن الفيديو عام.`
    );
  } finally {
    await removeFile(filePath);
  }
}

async function handleFilterOnImage(ctx, file, filterName, replyToMessageId) {
  const userName = getUserName(ctx);
  const statusMessage = await ctx.reply(`${userName}، جاري تطبيق الفلتر على الصورة، لحظة...`);

  try {
    await ctx.sendChatAction('upload_photo');
    const filter = resolveFilter(filterName);
    if (!filter) {
      await replaceStatus(
        ctx,
        statusMessage,
        `${userName}، ما لقيت فلتر بهذا الاسم.\n\n${filtersHelp()}`
      );
      return;
    }

    const { buffer, mime } = await loadImage(ctx, file);
    if (buffer.length > config.image.maxSizeMb * 1024 * 1024) {
      await replaceStatus(
        ctx,
        statusMessage,
        `${userName}، الصورة كبيرة (${(buffer.length / (1024 * 1024)).toFixed(1)} ميجابايت)، الحد الأقصى ${config.image.maxSizeMb} ميجابايت.`
      );
      return;
    }

    const result = await applyImageFilter(buffer, filter.id, mime);
    if (!result.ok) {
      await replaceStatus(ctx, statusMessage, `${userName}، تعذر تطبيق الفلتر على هذه الصورة.`);
      return;
    }

    await ctx.replyWithPhoto(
      { source: result.buffer },
      {
        caption: `${userName}، تم تطبيق فلتر: ${result.filter.label}`,
        reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
      }
    );
    await clearStatus(ctx, statusMessage);
  } catch (error) {
    log(`Image filter error: ${error.message}`);
    await replaceStatus(
      ctx,
      statusMessage,
      `${userName}، ما قدرت أعالج هذه الصورة. جرب صورة ثانية.`
    );
  }
}

async function handleImageMessage(ctx) {
  const userName = getUserName(ctx);
  const caption = (ctx.message.caption ?? '').trim();
  const file = getImageFile(ctx.message);
  if (!file) return;

  const intent = parseImageCaption(caption);

  if (intent.type === 'help') {
    return ctx.reply(filtersHelp());
  }
  if (intent.type === 'none') {
    return ctx.reply(imageHelpText(userName));
  }
  if (intent.type === 'filter') {
    return handleFilterOnImage(ctx, file, intent.value, ctx.message.message_id);
  }

  if (!isAIConfigured) {
    return ctx.reply(
      'الذكاء الاصطناعي غير مُهيأ. أضف USER_LLM_API_KEY في ملف .env ثم أعد التشغيل.'
    );
  }

  const statusMessage = await ctx.reply(`${userName}، جاري تحليل الصورة، لحظة...`);
  try {
    await ctx.sendChatAction('typing');
    const { buffer, mime } = await loadImage(ctx, file);
    if (buffer.length > config.image.maxSizeMb * 1024 * 1024) {
      await replaceStatus(
        ctx,
        statusMessage,
        `${userName}، الصورة كبيرة (${(buffer.length / (1024 * 1024)).toFixed(1)} ميجابايت)، الحد الأقصى ${config.image.maxSizeMb} ميجابايت.`
      );
      return;
    }

    if (canGenerateImages()) {
      try {
        const edited = await editImageWithGemini(buffer, mime, intent.value);
        await ctx.replyWithPhoto(
          { source: edited.buffer },
          {
            caption: edited.text || `${userName}، تم تعديل الصورة بالذكاء الاصطناعي.`,
            reply_parameters: { message_id: ctx.message.message_id },
          }
        );
        await clearStatus(ctx, statusMessage);
        return;
      } catch (editError) {
        log(`AI image edit failed, falling back to analysis: ${editError.message}`);
      }
    }

    const dataUrl = toDataUrl(buffer, mime);
    const answer = await askAIWithImage(ctx.chat.id, intent.value, dataUrl, userName);
    await ctx.reply(answer, {
      reply_parameters: { message_id: ctx.message.message_id },
    });
    await clearStatus(ctx, statusMessage);
  } catch (error) {
    log(`Image AI error: ${error.message}`);
    await replaceStatus(
      ctx,
      statusMessage,
      `${userName}، ما قدرت أحلل هذه الصورة. جرب مرة ثانية أو اشرح لي سؤالك بالكتابة.`
    );
  }
}

bot.on('photo', handleImageMessage);

bot.on('document', async (ctx, next) => {
  if (!getImageFile(ctx.message)) return next();
  return handleImageMessage(ctx);
});

bot.on('text', async (ctx) => {
  const text = (ctx.message.text ?? '').trim();
  if (!text) return;

  trackUser(ctx);
  trackMessage(ctx.from?.id);

  const tiktokUrl = extractTikTokUrl(text);
  if (tiktokUrl) {
    return handleTikTok(ctx, tiktokUrl);
  }

  if (FILTER_PREFIX.test(text)) {
    return ctx.reply(
      `${getUserName(ctx)}، عشان أطبق الفلتر أرسل الصورة مع تعليق بالشكل: فلتر <الاسم>.\nأو ردّ على صورة بالأمر: /filter <الاسم>.\nلستة الفلاتر: /filters`
    );
  }

  if (text.startsWith('/')) {
    return ctx.reply(`${getUserName(ctx)}، أمر غير معروف. أرسل /help لمعرفة طريقة الاستخدام.`);
  }

  return handleAI(ctx, text);
});

bot.hears('📥 تحميل فيديو', (ctx) =>
  ctx.reply(`${getUserName(ctx)}، أرسل رابط فيديو تيك توك الآن.`)
);

bot.hears('📧 إيميل مؤقت', async (ctx) => {
  const result = await handleEmail(ctx);
  trackEmail(ctx.from?.id);
  return result;
});

bot.hears('📱 رقم وهمي', (ctx) => handleNumberMenu(ctx));

bot.hears('🧠 اسأل الذكاء', (ctx) =>
  ctx.reply(`${getUserName(ctx)}، اكتب سؤالك الآن.`)
);

bot.hears('🎨 اسم مزخرف', (ctx) =>
  ctx.reply(`${getUserName(ctx)}، اكتب:\n/name محمد`)
);

bot.hears('🖼️ فلتر صور', (ctx) =>
  ctx.reply(`${getUserName(ctx)}، أرسل صورة مع:\n/filter rainbow`)
);

bot.hears('ℹ️ المساعدة', (ctx) => ctx.reply('اكتب /help'));
bot.catch((error, ctx) => {
  log(`Unhandled error for update ${ctx.update.update_id}: ${error.message}`);
});

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      status: 'ok',
      service: 'tiktok-ai-telegram-bot',
      aiConfigured: isAIConfigured,
      filters: listFilters().length,
    })
  );
});

server.on('error', (error) => {
  log(`Health server error: ${error.message}`);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}, shutting down`);
  saveStats();
  await bot.stop(signal).catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  startCleanupTimer();
  startSmsCleanupTimer();
  startStatsTimer();

  server.listen(config.server.port, () => {
    log(`Health server listening on port ${config.server.port}`);
  });

  await bot.launch({}, () => {
    log(`Bot @${bot.botInfo?.username ?? 'unknown'} is running`);
    log(`AI configured: ${isAIConfigured} (model: ${config.ai.model})`);
    log(`Available image filters: ${listFilters().length}`);
  });
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
