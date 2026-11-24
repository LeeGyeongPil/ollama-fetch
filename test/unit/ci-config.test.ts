// AC-9: CI 설정이 최소·고정·자기완결인지 파일 텍스트만 읽어 확인한다(YAML 라이브러리 없음).
//  ① .github/workflows/ci.yml  ② package.json  ③ package-lock.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from '../support/helpers.js';

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

/** 줄 끝 주석(# …)과 주석 줄을 뺀 YAML 텍스트. 따옴표 안의 # 는 이 파일에 없다 */
function withoutComments(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, ''))
    .filter((line) => line.trim() !== '');
}

describe('AC-9 CI workflow is minimal and pinned', () => {
  const raw = read('.github/workflows/ci.yml');
  const lines = withoutComments(raw);
  const body = lines.join('\n');

  it('has exactly one job on ubuntu-latest with Node "22" and a 10-minute limit', () => {
    const jobsAt = lines.findIndex((l) => l === 'jobs:');
    assert.ok(jobsAt >= 0, 'jobs: block');
    const jobNames = lines.slice(jobsAt + 1).filter((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
    assert.equal(jobNames.length, 1, `jobs: ${jobNames.join(', ')}`);
    assert.match(body, /^\s+runs-on: ubuntu-latest$/m);
    assert.match(body, /^\s+node-version: "22"$/m);
    const timeout = /^\s+timeout-minutes: (\d+)$/m.exec(body);
    assert.ok(timeout && Number(timeout[1]) <= 10, 'timeout-minutes <= 10');
    for (const word of ['matrix', 'cache:', 'schedule', 'continue-on-error', 'if:']) {
      assert.equal(body.includes(word), false, `no "${word}"`);
    }
  });

  it('pins both actions to a full commit SHA with a tag comment', () => {
    const uses = raw.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l));
    assert.equal(uses.length, 2);
    for (const line of uses) assert.match(line, /uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    assert.ok(uses[0].includes('actions/checkout@'));
    assert.ok(uses[1].includes('actions/setup-node@'));
  });

  it('runs exactly `npm ci --no-audit --no-fund` then `npm test`', () => {
    const runs = lines.filter((l) => /^\s*-?\s*run:/.test(l)).map((l) => l.replace(/^\s*-?\s*run:\s*/, ''));
    assert.deepEqual(runs, ['npm ci --no-audit --no-fund', 'npm test']);
  });

  it('reads the repository only and triggers on push to main, pull requests and manual runs', () => {
    assert.match(body, /^permissions:\n {2}contents: read$/m);
    assert.match(body, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {2}workflow_dispatch:$/m);
  });
});

describe('AC-9 package.json and lock file', () => {
  const pkg = JSON.parse(read('package.json')) as {
    version: string;
    engines: { node: string };
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const lock = JSON.parse(read('package-lock.json')) as {
    lockfileVersion: number;
    version: string;
    packages: Record<string, { version?: string; devDependencies?: Record<string, string>; engines?: Record<string, string> }>;
  };

  it('supports Node 22+, pins dev dependencies exactly and builds before testing', () => {
    assert.equal(pkg.engines.node, '>=22');
    assert.ok('typescript' in pkg.devDependencies, 'typescript is a dev dependency');
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly (got ${version})`);
    }
    assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
    assert.ok(pkg.scripts.test.startsWith('tsc -p .'), 'npm test compiles first');
    assert.match(pkg.scripts.test, /scripts\/run-tests\.mjs unit$/);
    assert.match(pkg.scripts['test:net'], /scripts\/run-tests\.mjs net$/);
    assert.match(pkg.scripts['test:e2e'], /scripts\/run-tests\.mjs e2e$/);
  });

  it('lock file v3 matches package.json', () => {
    assert.equal(lock.lockfileVersion, 3);
    const root = lock.packages[''];
    assert.equal(lock.version, pkg.version);
    assert.equal(root.version, pkg.version);
    assert.deepEqual(root.devDependencies, pkg.devDependencies);
    assert.deepEqual(root.engines, pkg.engines);
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} locked at ${version}`);
    }
  });
});
