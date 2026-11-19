import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root = process.cwd();
const require = createRequire(path.join(root, 'src/frontend/autotable-src/package.json'));
const yaml = require('js-yaml');
const workflow = yaml.load(fs.readFileSync('.github/workflows/migration-build.yml', 'utf8'));
const description = JSON.parse(execFileSync('python3', ['-B', 'tests/migration/run_source_ci.py', '--describe'], { encoding: 'utf8' }));

test('PR source workflow runs exact WebGL-only source groups without licensed/prebuilt engine gates', () => {
  assert.deepEqual(workflow.on.pull_request.branches, ['dev', 'main']);
  assert.deepEqual(workflow.on.push.branches, ['dev', 'main']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs['licensed-unity'], undefined);
  for (const group of Object.keys(description.plans)) {
    const job = workflow.jobs[group];
    assert(job);
    assert.equal(job.if, undefined);
    assert(job.steps.some(step => step.run === `python3 -B tests/migration/run_source_ci.py ${group} --install-dependencies`));
    const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(upload.if, 'always()');
    assert.equal(upload.with['if-no-files-found'], 'error');
    assert.deepEqual(upload.with.path.trim().split('\n'), description.evidencePaths[group]);
  }
  const backend = description.plans.backend.find(item => item.name === 'backend-tests');
  const selectors = backend.argv[backend.argv.indexOf('--filter') + 1].split('|');
  assert(selectors.includes('FullyQualifiedName~.Changsha.BotPacingTests'),
    'Canonical backend CI must execute the real bot pacing regression class');
  assert(selectors.includes('FullyQualifiedName~.Autotable.ClaimWindowTimingTests'),
    'Canonical backend CI must execute the real public-deadline and late-human-claim regressions');
  for (const selector of ['.Autotable.BotDisplayNameTests', '.Autotable.HandResultGroupingTests']) {
    assert(selectors.includes(`FullyQualifiedName~${selector}`),
      `Canonical backend CI must execute the actual display-name/grouped-result class: ${selector}`);
  }
  assert.equal(new Set(selectors).size, selectors.length);
  assert.equal(backend.expected, 239, 'Retain 206 existing, eleven pacing, four claim timing, and eighteen names/grouping cases');
  const contracts = description.plans['frontend-source'].find(item => item.name === 'workflow-contracts');
  assert(contracts.argv.includes('tests/migration/browser-ux.test.mjs'),
    'Browser harness navigation guards must run in canonical source CI');
  assert.equal(contracts.expected, 6);
});

test('frontend inventory retains authority/input/layout/privacy callers and actual default graph checks', () => {
  const tests = description.plans['frontend-source'].find(item => item.name === 'frontend-tests');
  for (const name of ['renderer-actions', 'renderer-frame', 'renderer-camera-controls', 'webgl-style', 'webgl-build', 'webgl-renderer', 'webgl-table-layout']) {
    assert(tests.argv.includes(`tests/node/${name}.test.mjs`));
  }
  assert(tests.argv.includes('tests/node/lobby-setup.test.mjs'),
    'The newly named setup regression file is not selected by renderer/webgl globs');
  assert(tests.argv.includes('tests/node/webgl-meld-callout.test.mjs'),
    'Canonical frontend CI must include the actual typed-callout/claim-clock regressions');
  for (const name of ['browser-tile-ui', 'browser-webgl-lifecycle', 'tile-ui', 'move-log-tile']) {
    assert(tests.argv.includes(`tests/node/${name}.test.mjs`),
      `Canonical frontend CI must explicitly execute the new UI/pixel regression: ${name}`);
  }
  assert(!tests.argv.includes('tests/node/tile-ui-test-support.mjs'),
    'Fixture support is not a standalone test inventory entry');
  assert.equal(new Set(tests.argv).size, tests.argv.length);
  assert.equal(tests.expected, 208);
  const commands = JSON.stringify(description.plans);
  assert.doesNotMatch(commands, /UNITY_LICENSE|unity-webgl|verify-unity|build_unity|baseline-fetch/);
});

test('hosted Docker smoke and Compose use the renamed image without replacing persistent volumes', () => {
  const job = workflow.jobs['image-runtime'];
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  const commands = job.steps.map(step => step.run ?? '').join('\n');
  assert.match(commands, /docker build.*BUILD_SHA/);
  assert.match(commands, /container_smoke\.py/);
  for (const step of job.steps.filter(step => /docker build|container_(?:proxy_)?smoke\.py/.test(step.run ?? ''))) {
    assert.match(step.run, /(?:--tag|--image) mahjong-webgl:ci(?: |$)/);
  }
  assert.doesNotMatch(commands, /login|push|ghcr-production|imagetools create|5086/);
  assert.deepEqual(job.permissions ?? workflow.permissions, { contents: 'read' });
  const compose = yaml.load(fs.readFileSync('docker-compose.yml', 'utf8'));
  assert.equal(compose.services.mahjong.image, '${MAHJONG_IMAGE:-mahjong-webgl:local}');
  assert.equal(compose.name, undefined, 'Do not silently replace the existing operator-selected Compose project');
  assert.deepEqual(compose.services.mahjong.volumes, ['mahjong-data:/data', 'bootstrap-cache:/app/data']);
  assert.deepEqual(Object.keys(compose.volumes).sort(), ['bootstrap-cache', 'mahjong-data']);
  for (const [provider, mount] of [['postgres', '/var/lib/postgresql/data'], ['sqlserver', '/var/opt/mssql']]) {
    const overlay = yaml.load(fs.readFileSync(`docker-compose.${provider}.yml`, 'utf8'));
    assert.equal(overlay.services.mahjong.image, undefined, 'Provider overlays must inherit the renamed app image');
    assert.equal(overlay.name, undefined);
    assert.deepEqual(overlay.services[provider].volumes, [`mahjong-${provider}-data:${mount}`]);
    assert.deepEqual(Object.keys(overlay.volumes), [`mahjong-${provider}-data`]);
  }
});

test('registry workflow identity/protected promotion and all actions remain pinned', () => {
  for (const name of ['ghcr-publish', 'ghcr-promote']) {
    const item = yaml.load(fs.readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
    for (const job of Object.values(item.jobs)) {
      assert.equal(job.if, "github.repository == 'long2know/mahjong-webgl' && github.ref == 'refs/heads/main'");
      if (name === 'ghcr-promote') {
        assert.equal(job.environment.name, 'ghcr-production');
        assert.equal(job.environment.url, 'https://github.com/long2know/mahjong-webgl/pull/${{ inputs.acceptance_pr }}');
      } else {
        const build = job.steps.find(step => step.uses?.startsWith('docker/build-push-action@'));
        assert.deepEqual(build.with.tags.trim().split('\n'), [
          'ghcr.io/long2know/mahjong-webgl:candidate-${{ github.run_id }}-${{ github.run_attempt }}',
          'ghcr.io/long2know/mahjong-webgl:sha-${{ inputs.source_sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
        ]);
        assert.match(build.with.labels, /^org\.opencontainers\.image\.source=https:\/\/github\.com\/long2know\/mahjong-webgl$/m);
      }
    }
  }
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps.filter(step => step.uses)) {
    assert.match(step.uses, /^[\w/-]+@[0-9a-f]{40}$/);
    if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
  }
});
