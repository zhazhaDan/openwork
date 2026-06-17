#!/usr/bin/env node
/**
 * 诊断脚本 - 单 session 极简测试，看看返回结构和 LLM 是否工作
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(__dirname, 'test-workspace');
const PORT = 6791;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // 准备
  await fs.mkdir(BASE, { recursive: true });
  await fs.writeFile(path.join(BASE, 'marker.txt'), 'Hello from POC');

  // 启动 tron
  console.log('启动 tron serve...');
  const tron = spawn('tron', [
    'serve',
    '--port', String(PORT),
    '--hostname', '127.0.0.1',
    '--log-level', 'INFO',
    '--print-logs',
  ], {
    cwd: BASE,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tron.stdout.on('data', c => process.stdout.write(`[TRON] ${c}`));
  tron.stderr.on('data', c => process.stderr.write(`[TRON E] ${c}`));

  await sleep(3000);

  // 创建 session
  const client = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${PORT}`,
    directory: BASE,
  });

  console.log('\n=== 1. 检查 provider 配置 ===');
  try {
    const providers = await client.config.providers();
    console.log('Providers:', JSON.stringify(providers.data, null, 2).slice(0, 500));
  } catch (e) {
    console.error('providers 失败:', e.message);
  }

  console.log('\n=== 2. 创建 session ===');
  const session = await client.session.create({
    body: { title: 'test' },
    query: { directory: BASE }
  });
  console.log('Session 创建结果:');
  console.log(JSON.stringify(session.data, null, 2));

  console.log('\n=== 3. 发送 prompt ===');
  try {
    const promptResp = await client.session.prompt({
      path: { id: session.data.id },
      body: {
        parts: [{ type: 'text', text: '请用一个词回答：你好' }]
      },
      query: { directory: BASE }
    });
    console.log('Prompt 响应结构:');
    console.log(JSON.stringify(promptResp.data, null, 2).slice(0, 1000));
  } catch (e) {
    console.error('prompt 失败:', e.message);
    if (e.cause) console.error('cause:', e.cause);
  }

  console.log('\n等待 15 秒让 LLM 处理...');
  await sleep(15000);

  console.log('\n=== 4. 获取所有消息 ===');
  const msgs = await client.session.messages({ path: { id: session.data.id } });
  console.log('Messages 结构:');
  console.log(JSON.stringify(msgs.data, null, 2).slice(0, 2000));

  // 清理
  tron.kill('SIGTERM');
  await sleep(1000);
  if (!tron.killed) tron.kill('SIGKILL');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
