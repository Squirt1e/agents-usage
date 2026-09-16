import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 发布流水线是本仓库唯一的出包入口：main 一推就打包通用 dmg，并把它挂到 package.json
// 里那个版本的 release 上。它的接线全是文本，没有类型系统守着，改错了要等下一次发版
// （甚至只会在 GitHub 上）才暴露，所以在这里把四条契约钉死：触发时机、版本号来源、
// 打包目标、发布方式。仓库里不额外引 YAML 解析器，断言按行读取，只依赖键名不依赖缩进。

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
    expect(workflow).toContain('tag="v${{ steps.version.outputs.version }}"');
    // 一处写死的版本号就会和 package.json 各自漂移，tag 与资产名跟着错版。
    expect(workflow).not.toContain(packageJson.version);
  });

  it('打的正是对外承诺的通用 dmg', () => {
    expect(workflow).toContain('npm run build:desktop -- --target universal-apple-darwin');
    expect(workflow).toContain('target/universal-apple-darwin/release/bundle/dmg/*.dmg');
  });

  it('替换已有 release 的资产，但正文永远由人写', () => {
    expect(workflow).toMatch(/contents: write/);
    expect(workflow).toContain('gh release upload "$tag" "${dmgs[0]}" --clobber');
    // 新版本先建成 draft：自动变更列表只是占位，手写说明之后再发布。
    expect(workflow).toMatch(/gh release create "\$tag" --draft/);
    expect(workflow).not.toContain('gh release edit');
    expect(workflow).not.toContain('--notes');
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
