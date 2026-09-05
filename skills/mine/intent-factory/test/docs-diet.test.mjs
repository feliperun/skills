import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILL_BYTE_CEILING = 6000;
const skillPath = fileURLToPath(new URL('../SKILL.md', import.meta.url));

test('SKILL.md stays within the router byte ceiling', () => {
  const bytes = statSync(skillPath).size;
  assert.ok(bytes > 0, 'SKILL.md must not be empty');
  assert.ok(
    bytes <= SKILL_BYTE_CEILING,
    `SKILL.md is ${bytes} bytes; the router ceiling is ${SKILL_BYTE_CEILING} bytes. ` +
      'Move detail into skills/mine/intent-factory/references/ and link it from the router.',
  );
});

test('every reference the router links to exists', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const links = [...skill.matchAll(/\]\((references\/[A-Za-z0-9._-]+\.md)\)/g)].map(
    (match) => match[1],
  );
  assert.ok(links.length > 0, 'the router must link at least one reference');
  for (const link of new Set(links)) {
    const target = fileURLToPath(new URL(`../${link}`, import.meta.url));
    assert.ok(statSync(target).isFile(), `${link} is linked by SKILL.md but missing`);
  }
});

test('the router documents runtimeRules failover', () => {
  const skill = readFileSync(skillPath, 'utf8');
  assert.match(skill, /runtimeRules/);
  assert.match(skill, /failover/i);
});
