import { createServer } from 'node:http';
import { Telegraf } from 'telegraf';
import { config, isAIConfigured, TIKTOK_URL_PATTERN } from './config.js';
import { askAI, resetHistory } from './ai.js';
import { downloadTikTokVideo, normalizeTikTokUrl, removeFile } from './tiktok.js';

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

const WELCOME = [
  'أهلاً بك! أقدر أساعدك في:',
  '',
  '1) تنزيل فيديوهات تيك توك - أرسل أي رابط تيك توك.',
  '2) الإجابة على أسئلتك بالذكاء الاصطناعي - أرسل أي رسالة.',
  '',
  'الأوامر:',
  '/start - رسالة الترحيب',
  '/help - طريقة الاستخدام',
  '/ai <سؤال> - سؤال مباشر للذكاء الاصطناعي',
  '/reset - حذف ذاكرة المحادثة',
].join('\n');

bot.start((ctx) =>
  ctx.reply(`أهلاً ${getUserName(ctx)}!\n\n${WELCOME}`)
);

bot.help((ctx) =>
  ctx.reply(
    [
      `${getUserName(ctx)}، طريقة الاستخدام:`,
      '',
      'أرسل رابط فيديو تيك توك لينزل لك الفيديو.',
      'أو أرسل أي سؤال والذكاء الاصطناعي يجاوبك.',
      '',
      '/ai <سؤال> - سؤال مباشر للذكاء الاصطناعي',
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
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        undefined,
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
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});
  } catch (error) {
    log(`Download error: ${error.message}`);
    await ctx.telegram
      .editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        undefined,
        `${userName}، ما قدرت أنزل هذا الفيديو. تأكد أن الرابط صحيح وأن الفيديو عام.`
      )
      .catch(() => {});
  } finally {
    await removeFile(filePath);
  }
}

bot.on('text', async (ctx) => {
  const text = (ctx.message.text ?? '').trim();
  if (!text) return;

  const tiktokUrl = extractTikTokUrl(text);
  if (tiktokUrl) {
    return handleTikTok(ctx, tiktokUrl);
  }

  if (text.startsWith('/')) {
    return ctx.reply(`${getUserName(ctx)}، أمر غير معروف. أرسل /help لمعرفة طريقة الاستخدام.`);
  }

  return handleAI(ctx, text);
});

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
  await bot.stop(signal).catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  server.listen(config.server.port, () => {
    log(`Health server listening on port ${config.server.port}`);
  });

  await bot.launch({}, () => {
    log(`Bot @${bot.botInfo?.username ?? 'unknown'} is running`);
    log(`AI configured: ${isAIConfigured} (model: ${config.ai.model})`);
  });
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
          
