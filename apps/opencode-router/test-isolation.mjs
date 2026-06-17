#!/usr/bin/env node
/**
 * 快速验证：tron-ai 单实例多 session 隔离性
 *
 * 简化版 - 只测试核心问题：
 * 1. 能否创建多个 session
 * 2. 不同 session 能否指定不同 directory
 * 3. directory 参数是否真的生效
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 找到 tron 二进制
const TRON_BIN = (() => {
  const candidates = [
    path.join(__dirname, '../../../node_modules/tron-ai/bin/tron'),
    path.join(__dirname, 'node_modules/tron-ai/bin/tron'),
  ];
  for (const p of candidates) {
    try {
      if (require('fs').existsSync(p)) return p;
    } catch {}
  }
  return 'tron'; // fallback 全局
})();

console.log(`
╔══════════════════════════════════════════════════════════╗
║  tron-ai 多 session 隔离性 - 快速验证                   ║
╚══════════════════════════════════════════════════════════╝

使用 tron 二进制: ${TRON_BIN}
`);

const BASE = path.join(__dirname, 'test-workspace');
const PORT = 6790;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 准备测试目录
async function setup() {
  console.log('[1/5] 准备测试目录...');
  await fs.rm(BASE, { recursive: true, force: true });
  await fs.mkdir(BASE, { recursive: true });

  await fs.mkdir(path.join(BASE, 'workspace_A'), { recursive: true });
  await fs.mkdir(path.join(BASE, 'workspace_B'), { recursive: true });

  await fs.writeFile(
    path.join(BASE, 'workspace_A', 'marker.txt'),
    'This is workspace A'
  );
  await fs.writeFile(
    path.join(BASE, 'workspace_B', 'marker.txt'),
    'This is workspace B'
  );

  console.log('✅ 目录准备完成');
  console.log(`   ${BASE}/workspace_A/marker.txt`);
  console.log(`   ${BASE}/workspace_B/marker.txt`);
}

// 启动 tron serve
async function startTron() {
  console.log('\n[2/5] 启动 tron serve...');

  return new Promise((resolve, reject) => {
    const proc = spawn(TRON_BIN, [
      'serve',
      '--port', String(PORT),
      '--hostname', '127.0.0.1',
    ], {
      cwd: BASE,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        console.log('⚠️  未检测到启动日志，尝试继续...');
        resolve(proc);
      }
    }, 3000);

    proc.stdout.on('data', chunk => {
      const text = chunk.toString();
      if (text.includes('listening') || text.includes('started')) {
        clearTimeout(timeout);
        started = true;
        console.log('✅ tron-ai 已启动');
        resolve(proc);
      }
    });

    proc.stderr.on('data', chunk => {
      console.error('[TRON ERROR]', chunk.toString());
    });

    proc.on('error', reject);
  });
}

// 核心测试
async function testIsolation() {
  const baseUrl = `http://127.0.0.1:${PORT}`;

  console.log('\n[3/5] 创建两个 session，绑定不同目录...');

  const dirA = path.join(BASE, 'workspace_A');
  const dirB = path.join(BASE, 'workspace_B');

  const clientA = createOpencodeClient({ baseUrl, directory: dirA });
  const clientB = createOpencodeClient({ baseUrl, directory: dirB });

  const sessionA = await clientA.session.create({
    body: { title: 'Session A' },
    query: { directory: dirA }
  });

  const sessionB = await clientB.session.create({
    body: { title: 'Session B' },
    query: { directory: dirB }
  });

  console.log(`✅ Session A: ${sessionA.data.id} → ${dirA}`);
  console.log(`✅ Session B: ${sessionB.data.id} → ${dirB}`);

  console.log('\n[4/5] 测试文件隔离性...');
  console.log('发送 prompt: "用 Read 工具读取 marker.txt 内容"');

  // Session A 读取
  await clientA.session.prompt({
    path: { id: sessionA.data.id },
    body: {
      parts: [{ type: 'text', text: '请用 Read 工具读取 marker.txt 文件的内容，并直接告诉我文件里写了什么' }]
    },
    query: { directory: dirA }
  });

  // Session B 读取
  await clientB.session.prompt({
    path: { id: sessionB.data.id },
    body: {
      parts: [{ type: 'text', text: '请用 Read 工具读取 marker.txt 文件的内容，并直接告诉我文件里写了什么' }]
    },
    query: { directory: dirB }
  });

  console.log('⏳ 等待 LLM 处理...');
  await sleep(8000);

  // 获取结果
  const msgsA = await clientA.session.messages({ path: { id: sessionA.data.id } });
  const msgsB = await clientB.session.messages({ path: { id: sessionB.data.id } });

  const lastA = msgsA.data?.messages?.[msgsA.data.messages.length - 1];
  const lastB = msgsB.data?.messages?.[msgsB.data.messages.length - 1];

  const replyA = lastA?.parts?.find(p => p.type === 'text')?.text || 'no reply';
  const replyB = lastB?.parts?.find(p => p.type === 'text')?.text || 'no reply';

  console.log('\n[5/5] 结果分析');
  console.log('─'.repeat(60));
  console.log(`Session A 回复:\n${replyA.slice(0, 200)}\n`);
  console.log(`Session B 回复:\n${replyB.slice(0, 200)}\n`);
  console.log('─'.repeat(60));

  // 判断
  const aHasA = replyA.toLowerCase().includes('workspace a');
  const bHasB = replyB.toLowerCase().includes('workspace b');
  const aHasB = replyA.toLowerCase().includes('workspace b');
  const bHasA = replyB.toLowerCase().includes('workspace a');

  console.log('\n✨ 最终判断:');

  if (aHasA && bHasB && !aHasB && !bHasA) {
    console.log('✅ 隔离成功！');
    console.log('   - Session A 读到了 workspace A 的内容');
    console.log('   - Session B 读到了 workspace B 的内容');
    console.log('   - 两者互不干扰');
    console.log('\n结论: 可以安全使用单 tron-ai 实例 + 多 session + 按用户分目录\n');
    return true;
  } else {
    console.log('❌ 隔离失败或不确定');
    console.log(`   - Session A 读到 workspace A: ${aHasA ? '是' : '否'}`);
    console.log(`   - Session B 读到 workspace B: ${bHasB ? '是' : '否'}`);
    console.log(`   - Session A 读到 workspace B: ${aHasB ? '是' : '否'} ${aHasB ? '← 问题!' : ''}`);
    console.log(`   - Session B 读到 workspace A: ${bHasA ? '是' : '否'} ${bHasA ? '← 问题!' : ''}`);
    console.log('\n结论: 需要进一步调查或改用其他方案\n');
    return false;
  }
}

// 主流程
async function main() {
  let tronProc;

  try {
    await setup();
    tronProc = await startTron();
    await sleep(2000);

    const isolated = await testIsolation();

    process.exit(isolated ? 0 : 1);
  } catch (error) {
    console.error('\n💥 测试失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    if (tronProc) {
      console.log('\n清理: 停止 tron serve...');
      tronProc.kill('SIGTERM');
      await sleep(1000);
      if (!tronProc.killed) tronProc.kill('SIGKILL');
    }
  }
}

main();
