import 'dotenv/config';

function required(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback = '') {
  return (process.env[name] ?? fallback).trim();
}

function toInt(name, fallback) {
  const raw = optional(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  botToken: required('BOT_TOKEN'),

  ai: {
    apiKey: optional('USER_LLM_API_KEY'),
    baseUrl: optional(
      'USER_LLM_BASE_URL',
      'https://generativelanguage.googleapis.com/v1beta/openai/'
    ),
    model: optional('USER_LLM_MODEL', 'gemini-2.0-flash'),
    visionModel: optional('USER_LLM_VISION_MODEL', optional('USER_LLM_MODEL', 'gemini-2.0-flash')),
    systemPrompt: optional(
      'USER_LLM_SYSTEM_PROMPT',
      'أنت مساعد ذكي في بوت تيليجرام. جاوب بنفس لغة المستخدم، وخلّي الردود واضحة ومختصرة.'
    ),
    maxHistoryMessages: toInt('USER_LLM_MAX_HISTORY', 12),
    maxTokens: toInt('USER_LLM_MAX_TOKENS', 1024),
  },

  download: {
    maxSizeMb: toInt('MAX_VIDEO_SIZE_MB', 49),
    timeoutMs: toInt('DOWNLOAD_TIMEOUT_MS', 120000),
    tempDir: optional('TEMP_DIR', 'tmp'),
    ytDlpBinary: optional('YTDLP_BINARY', 'yt-dlp'),
  },

  image: {
    maxSizeMb: toInt('IMAGE_MAX_SIZE_MB', 20),
    tempDir: optional('IMAGE_TEMP_DIR', 'tmp'),
    editModel: optional('USER_LLM_IMAGE_MODEL', 'gemini-2.5-flash-image'),
  },

  server: {
    port: toInt('PORT', 3000),
  },
};

export const isAIConfigured = Boolean(config.ai.apiKey);

export const TIKTOK_URL_PATTERN =
  /https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s]+/i;
