import OpenAI from 'openai';
import { config } from './config.js';

let client = null;

function getClient() {
  if (!config.ai.apiKey) {
    throw new Error(
      'AI is not configured. Set USER_LLM_API_KEY (and optionally USER_LLM_BASE_URL / USER_LLM_MODEL) in the .env file.'
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey: config.ai.apiKey,
      baseURL: config.ai.baseUrl,
    });
  }
  return client;
}

const history = new Map();

function getHistory(chatId) {
  if (!history.has(chatId)) {
    history.set(chatId, []);
  }
  return history.get(chatId);
}

function trimHistory(messages) {
  const limit = Math.max(2, config.ai.maxHistoryMessages);
  if (messages.length > limit) {
    messages.splice(0, messages.length - limit);
  }
}

export function resetHistory(chatId) {
  history.delete(chatId);
}

function sanitizeName(name) {
  if (!name) return '';
  return String(name).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60);
}

function buildSystemPrompt(userName) {
  const name = sanitizeName(userName);
  if (!name) {
    return config.ai.systemPrompt;
  }
  return [
    config.ai.systemPrompt,
    `اسم المستخدم الذي تتحدث معه هو "${name}". ابدأ ردك بمناداته باسمه، مثال: "${name}، ...".`,
  ].join('\n');
}

export async function askAI(chatId, prompt, userName = '') {
  const openai = getClient();
  const messages = getHistory(chatId);
  messages.push({ role: 'user', content: prompt });
  trimHistory(messages);

  try {
    const completion = await openai.chat.completions.create({
      model: config.ai.model,
      max_tokens: config.ai.maxTokens,
      messages: [{ role: 'system', content: buildSystemPrompt(userName) }, ...messages],
    });

    const answer = completion?.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      throw new Error('Empty response from the AI provider');
    }

    messages.push({ role: 'assistant', content: answer });
    trimHistory(messages);
    return answer;
  } catch (error) {
    messages.pop();
    throw error;
  }
  }
