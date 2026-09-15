import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Download timed out'));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Command exited with code ${code}`));
    });
  });
}

async function hasYtDlp() {
  try {
    await run(config.download.ytDlpBinary, ['--version'], 15000);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/plain, */*' },
  });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json();
}

async function downloadFile(url, targetPath, timeoutMs) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': USER_AGENT },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download media (status ${response.status})`);
  }
  await pipeline(response.body, createWriteStream(targetPath));
}

export function normalizeTikTokUrl(rawUrl) {
  return rawUrl.replace(/[.,!؟)»"'\]}]+$/u, '').trim();
}

async function ensureTempDir() {
  const dir = path.resolve(process.cwd(), config.download.tempDir);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function downloadWithYtDlp(url, workDir) {
  const target = path.join(workDir, `${randomUUID()}.mp4`);
  await run(
    config.download.ytDlpBinary,
    [
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--no-part',
      '--format',
      'mp4/best',
      '--output',
      target,
      url,
    ],
    config.download.timeoutMs
  );

  const { size } = await stat(target);
  return { filePath: target, sizeBytes: size, source: 'yt-dlp' };
}

async function downloadWithTikwm(url, workDir) {
  const endpoint = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
  const payload = await fetchJson(endpoint, config.download.timeoutMs);

  if (!payload || payload.code !== 0 || !payload.data) {
    throw new Error(payload?.msg || 'TikTok link could not be resolved');
  }

  const media = payload.data.hdplay || payload.data.play;
  if (!media) {
    throw new Error('No downloadable video was found for this link');
  }

  const mediaUrl = media.startsWith('http') ? media : `https://www.tikwm.com${media}`;
  const target = path.join(workDir, `${randomUUID()}.mp4`);
  await downloadFile(mediaUrl, target, config.download.timeoutMs);

  const { size } = await stat(target);
  return { filePath: target, sizeBytes: size, source: 'tikwm' };
}

export async function downloadTikTokVideo(rawUrl) {
  const url = normalizeTikTokUrl(rawUrl);
  const workDir = await ensureTempDir();
  const errors = [];

  if (await hasYtDlp()) {
    try {
      return await downloadWithYtDlp(url, workDir);
    } catch (error) {
      errors.push(`yt-dlp: ${error.message}`);
    }
  }

  try {
    return await downloadWithTikwm(url, workDir);
  } catch (error) {
    errors.push(`tikwm: ${error.message}`);
  }

  throw new Error(errors.join(' | '));
}

export async function removeFile(filePath) {
  if (!filePath) return;
  await unlink(filePath).catch(() => {});
}

export async function cleanupTempDir() {
  try {
    const dir = await ensureTempDir();
    const entries = await readdir(dir);
    await Promise.all(entries.map((entry) => unlink(path.join(dir, entry)).catch(() => {})));
  } catch {
    // ignore cleanup errors
  }
    }
