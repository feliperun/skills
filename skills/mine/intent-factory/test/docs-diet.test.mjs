import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILL_BYTE_CEILING = 6144;
const CONTRACT_BYTE_CEILING = 20480;
const OPERATIONS_BYTE_CEILING = 10240;

const skillPath = fileURLToPath(new URL('../SKILL.md', import.meta.url));
const referencesDir = fileURLToPath(new URL('../references', import.meta.url));

test('SKILL.md stays within the router byte ceiling', () => {
  const bytes = statSync(skillPath).size;
  assert.ok(bytes > 0, 'SKILL.md must not be empty');
  assert.ok(
    bytes <= SKILL_BYTE_CEILING,
    `SKILL.md is ${bytes} bytes; the router ceiling is ${SKILL_BYTE_CEILING} bytes. ` +
      'Move detail into skills/mine/intent-factory/references/ and link it from the router.',
  );
});

test('references/contract.md and references/operations.md stay within their byte ceilings', () => {
  const contractBytes = statSync(fileURLToPath(new URL('../references/contract.md', import.meta.url))).size;
  const operationsBytes = statSync(fileURLToPath(new URL('../references/operations.md', import.meta.url))).size;
  assert.ok(contractBytes > 0, 'references/contract.md must not be empty');
  assert.ok(
    contractBytes <= CONTRACT_BYTE_CEILING,
    `references/contract.md is ${contractBytes} bytes; the ceiling is ${CONTRACT_BYTE_CEILING} bytes.`,
  );
  assert.ok(operationsBytes > 0, 'references/operations.md must not be empty');
  assert.ok(
    operationsBytes <= OPERATIONS_BYTE_CEILING,
    `references/operations.md is ${operationsBytes} bytes; the ceiling is ${OPERATIONS_BYTE_CEILING} bytes.`,
  );
});

test('references/ holds only contract.md and operations.md', () => {
  const entries = readdirSync(referencesDir).sort();
  assert.deepEqual(
    entries,
    ['contract.md', 'operations.md'],
    'the three-document diet keeps exactly contract.md and operations.md under references/',
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

test('the router documents runtimes[].fallback and no longer runtimeRules', () => {
  const skill = readFileSync(skillPath, 'utf8');
  assert.match(skill, /fallback/);
  assert.doesNotMatch(skill, /runtimeRules/);
});
