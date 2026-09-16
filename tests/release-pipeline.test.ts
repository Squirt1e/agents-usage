import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 发布流水线是本仓库唯一的出包入口：main 一推先判断这个版本发过没有，没发过才打包通用 dmg，
// 再用仓库里那份已提交的正文建一个公开的 release。它的接线全是文本，没有类型系统守着，改错了
// 要等下一次发版（甚至只会在 GitHub 上）才暴露，所以在这里把契约钉死：触发时机、版本号来源、
// 打包目标、同一个版本只打一次、正文来自已提交的文件、正文缺失即失败、出包即发布、已发出的
// 资产与正文不再变动。仓库里不额外引 YAML 解析器，断言按行读取，只依赖键名不依赖缩进。

/** 取某个顶层键下面的非注释行（到下一个顶层键为止），用来读 `on:` 这种小块。 */
function blockAfter(source: string, key: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) throw new Error(`工作流里没有 ${key}: 块`);

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (!line.startsWith(' ')) break;
    body.push(trimmed);
  }
  return body;
}

/** 取某个作业的整段文本（`jobs:` 下缩进两格的作业名，到下一个作业为止）。 */
function jobBlock(source: string, job: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) throw new Error(`工作流里没有 ${job} 作业`);

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[a-z][a-z-]*:$/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/** 取 markdown 里的 `##` 段落标题，按出现顺序。 */
function headings(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.trim());
}

/** 取某个 `##` 段落到下一个 `##` 之间的非空行。 */
function section(source: string, heading: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new Error(`正文里没有 ${heading}`);

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (line.trim() !== '') body.push(line.trim());
  }
  return body;
}

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
  version: string;
};
const cargoManifest = readFileSync('Cargo.toml', 'utf8');

describe('发布流水线', () => {
  it('只在 main 的推送上升起，别的分支与标签都不出包', () => {
    expect(blockAfter(workflow, 'on')).toEqual(['push:', 'branches: [main]']);
  });

  it('版本号只从 package.json 读，流水线里不留第二份', () => {
    expect(workflow).toContain("require('./package.json').version");
    expect(workflow).toContain('tag="v${{ needs.plan.outputs.version }}"');
    // 一处写死的版本号就会和 package.json 各自漂移，tag 与资产名跟着错版。
    expect(workflow).not.toContain(packageJson.version);
  });

  it('打的正是对外承诺的通用 dmg', () => {
    expect(workflow).toContain('npm run build:desktop -- --target universal-apple-darwin');
    expect(workflow).toContain('target/universal-apple-darwin/release/bundle/dmg/*.dmg');
  });

  it('同一个版本只打一次：tag 或 release 已存在就整段跳过打包', () => {
    // 判据两条：远端 tag 与 release（`gh release view` 连手工建的 draft 也看得见）。
    expect(workflow).toContain('refs/tags/$tag');
    expect(workflow).toContain('gh release view "$tag"');
    // 打包作业挂在这个判断上，所以版本没变时连 macOS runner 都不会起。
    expect(workflow).toContain("needs.plan.outputs.pack == 'true'");
  });

  it('正文取自仓库里那份已提交的文件，不由流水线生成', () => {
    // 正文与版本号同一条提交，来源单一；流水线只把它贴上去。
    expect(workflow).toContain('notes="docs/release-notes/$tag.md"');
    expect(workflow).toContain('--notes-file "$notes"');
    // 自动变更列表会把提交列表搬进 release，正是这一版要压掉的东西。
    expect(workflow).not.toContain('--generate-notes');
  });

  it('正文缺失时在打包之前失败，不发出没有正文的 release', () => {
    // 检查必须在 plan（ubuntu，几秒）里：macOS 上那轮构建要 90 分钟，缺文件是提交时就能
    // 发现的问题。plan 一失败，release 作业根本不会起。
    expect(jobBlock(workflow, 'plan')).toContain('if [[ ! -f "$notes" ]]');
    expect(jobBlock(workflow, 'plan')).toContain('exit 1');
  });

  it('出包即发布，不留一个等人补正文的 draft', () => {
    expect(workflow).toMatch(/gh release create "\$tag" --title "\$tag"/);
    expect(workflow).not.toContain('--draft');
  });

  it('已发出的资产与正文都不再被覆盖', () => {
    expect(workflow).toMatch(/contents: write/);
    // 覆盖资产正是被推翻的做法：同一个版本的 dmg 换了字节，正文里的说明就跟着失真。
    expect(workflow).not.toContain('gh release upload');
    expect(workflow).not.toContain('--clobber');
    // release 一次建成，没有第二步回去改它。
    expect(workflow).not.toContain('gh release edit');
  });
});

describe('release 正文', () => {
  const templatePath = 'docs/release-notes/TEMPLATE.md';
  const notesPath = `docs/release-notes/v${packageJson.version}.md`;

  it('随版本号一起提交，缺了就发不出包', () => {
    // 守卫与流水线的 plan 检查是同一件事的两半：这里在本地拦住，plan 在推送后拦住。
    expect(existsSync(notesPath)).toBe(true);
  });

  it('骨架与模板一致，多一段少一段都是有意改动模板', () => {
    expect(headings(readFileSync(notesPath, 'utf8'))).toEqual(
      headings(readFileSync(templatePath, 'utf8')),
    );
  });

  it('「这个版本里有什么」只有一句话', () => {
    const whatsNew = section(readFileSync(notesPath, 'utf8'), '## 这个版本里有什么');
    // 一句话 = 一个非空行；罗列提交、分点说明都会让这里变成多行。
    expect(whatsNew).toHaveLength(1);
    expect([...whatsNew[0]!].length).toBeLessThanOrEqual(80);
  });

  it('不写校验和：资产页上的 SHA-256 由 GitHub 现算', () => {
    expect(readFileSync(notesPath, 'utf8')).not.toMatch(/\b[0-9a-f]{64}\b/i);
  });
});

describe('发布版本号', () => {
  it('由 package.json 给出，tag 与 dmg 名字都用它', () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('打包时从 package.json 现读，不在 tauri.conf.json 里另存一份', () => {
    expect(tauriConfig.version).toBe('../package.json');
  });

  it('cargo 工作区版本跟着 package.json 走，不让两处各说各话', () => {
    const workspace = cargoManifest.split('[workspace.package]')[1] ?? '';
    expect(/^version = "([^"]+)"/m.exec(workspace)?.[1]).toBe(packageJson.version);
  });
});
