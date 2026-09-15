#!/usr/bin/env node
// 提交信息守卫：由 .husky/commit-msg 在每次提交时调用。
//
// 边界交给脚本而不是 commitlint，是因为「描述必须是中文」这条规则需要自定义实现，
// 而一个脚本可以同时被钩子和 tests/verify-commit-msg.test.ts 调用——
// 守卫测的就是钩子真正执行的那段逻辑。

import { readFileSync } from 'node:fs';

const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];
const HEADER_MAX = 72;

// <type>(<scope>): 中文描述 —— scope 可省略；分隔符固定为半角冒号加空格。
const HEADER_PATTERN = new RegExp(`^(${TYPES.join('|')})(?:\\(([^()]+)\\))?: (.+)$`);
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function verifyCommitMessage(raw) {
  const problems = [];

  // git 会把注释和 rebase 残留（diff 之后的剪裁行）一并写进消息文件，它们不属于提交信息。
  const lines = raw.split('\n');
  const cut = lines.findIndex((line) => line.startsWith('# ------------------------ >8 ------------------------'));
  const body = (cut === -1 ? lines : lines.slice(0, cut)).filter((line) => !line.startsWith('#'));
  const header = body.find((line) => line.trim() !== '');

  if (!header) {
    return ['提交信息为空'];
  }

  // 合并与回滚的标题由 git 生成或照抄上游，没有可写的中文描述。
  if (header.startsWith('Merge ') || header.startsWith('Revert ')) {
    return [];
  }

  if ([...header].length > HEADER_MAX) {
    problems.push(`标题 ${[...header].length} 个字符，超出 ${HEADER_MAX} 的上限：${header}`);
  }

  const match = HEADER_PATTERN.exec(header);
  if (!match) {
    problems.push(`标题必须形如 "<type>(<scope>): 中文描述"，scope 可省略，当前为：${header}`);
    problems.push(`可用 type：${TYPES.join(' / ')}`);
    return problems;
  }

  const subject = match[3];
  if (!CJK.test(subject)) {
    problems.push(`描述必须用中文书写，当前为：${subject}`);
  }
  if (/[。.；;，,]$/.test(subject)) {
    problems.push(`描述不要在结尾加标点，当前为：${subject}`);
  }

  return problems;
}

function main() {
  const messageFile = process.argv[2];
  if (!messageFile) {
    console.error('用法：node scripts/verify-commit-msg.mjs <COMMIT_EDITMSG 路径>');
    process.exit(2);
  }

  const problems = verifyCommitMessage(readFileSync(messageFile, 'utf8'));
  if (problems.length === 0) {
    return;
  }

  console.error('提交信息不符合仓库约定：');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error('示例：feat(panel): 新增配额条过渡动画');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
