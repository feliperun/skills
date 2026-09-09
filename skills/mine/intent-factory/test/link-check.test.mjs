import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = fileURLToPath(new URL('..', import.meta.url));
const docsDir = fileURLToPath(new URL('../../../../docs/intent-factory', import.meta.url));

const LINK_PATTERN = /\]\(([^)]+)\)/g;

/** @param {string} directory @returns {string[]} absolute paths of the *.md files directly inside it */
function markdownFilesIn(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(directory, name));
}

/** @param {string} filePath @returns {string[]} every relative markdown link target found in the file */
function relativeLinkTargets(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const targets = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    const target = match[1].trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // scheme URL (http:, mailto:, …)
    if (target.startsWith('#')) continue; // in-page anchor
    targets.push(target);
  }
  return targets;
}

const files = [
  join(skillDir, 'SKILL.md'),
  ...markdownFilesIn(join(skillDir, 'references')),
  ...markdownFilesIn(docsDir),
];

test('every relative markdown link in the skill docs resolves to a real file', () => {
  assert.ok(files.length > 0, 'expected at least one markdown file to check');
  for (const file of files) {
    for (const target of relativeLinkTargets(file)) {
      const withoutFragment = target.split('#')[0];
      const resolved = join(dirname(file), withoutFragment);
      assert.ok(
        statSync(resolved, { throwIfNoEntry: false })?.isFile(),
        `${target} linked from ${file} does not resolve to a real file (${resolved})`,
      );
    }
  }
});
