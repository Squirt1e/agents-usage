import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// 守卫直接跑钩子会执行的那条命令，所以「脚本判断」与「钩子接线」两件事都被覆盖。
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(repoRoot, 'scripts', 'verify-commit-msg.mjs');
const workDir = mkdtempSync(join(tmpdir(), 'agents-usage-commit-msg-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function run(message: string | null) {
  if (message === null) {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
  }
  const file = join(workDir, `message-${Math.random().toString(16).slice(2)}.txt`);
  writeFileSync(file, message, 'utf8');
  const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

describe('commit message convention', () => {
  it.each([
    ['feat(panel): 新增配额条过渡动画'],
    ['docs: 更新桌面面板说明'],
    ['fix(glm): 修正钱包开关关闭后的读数'],
    ['chore: 初始化工程配置与忽略规则\n\n补充说明可以写在正文里。']
  ])('accepts %s', (message) => {
    expect(run(message).status).toBe(0);
  });

  it.each([
    ['update: 换掉一个不认识的动作', '未知 type'],
    ['feat: add quota animation', '描述不是中文'],
    ['feat(panel) 新增动画', '缺少冒号分隔符'],
    ['feat(panel): 新增动画。', '描述结尾带标点'],
    ['feat(panel): ' + '很长的描述'.repeat(20), '标题超长'],
    ['', '空提交信息']
  ])('rejects %s (%s)', (message) => {
    const result = run(message);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('提交信息不符合仓库约定');
  });

  it('ignores comment lines and the scissors section written by git', () => {
    const message = [
      'feat(panel): 新增卡片入场动画',
      '# 请为你的提交输入说明。以 # 开头的行会被忽略。',
      '# ------------------------ >8 ------------------------',
      'diff --git a/src/desktop/panel/Panel.tsx b/src/desktop/panel/Panel.tsx'
    ].join('\n');

    expect(run(message).status).toBe(0);
  });

  it('lets git-generated merge and revert headers through', () => {
    expect(run("Merge branch 'main' into panel").status).toBe(0);
    expect(run('Revert "feat(panel): 新增卡片入场动画"').status).toBe(0);
  });

  it('requires the message file argument', () => {
    expect(run(null).status).toBe(2);
  });
});

describe('husky wiring', () => {
  it('runs the linter on staged files before committing', () => {
    expect(readFileSync(join(repoRoot, '.husky', 'pre-commit'), 'utf8')).toContain('npx lint-staged');

    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(packageJson.scripts.prepare).toBe('husky');
    expect(packageJson['lint-staged']).toBeTruthy();
  });

  it('checks the commit message through the same script this test guards', () => {
    expect(readFileSync(join(repoRoot, '.husky', 'commit-msg'), 'utf8')).toContain('scripts/verify-commit-msg.mjs');
  });
});
