import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillRegistry } from '../src/tools/skills.js';

test('skill registry imports, parses, enables, pins, and detects pinned changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-skills-'));
  try {
    const source = path.join(root, 'example');
    await mkdir(source);
    const skillFile = path.join(source, 'SKILL.md');
    await writeFile(skillFile, '---\nname: example\ndescription: Example skill\n---\n\nFollow these instructions.\n');
    const registry = new SkillRegistry({ manifestPath: path.join(root, 'manifest.json'), importRoots: [root] });
    const imported = await registry.importSkill(source);
    assert.equal(imported.name, 'example');
    assert.equal(imported.enabled, false);
    await registry.setEnabled('example', true);
    const pinned = await registry.pin('example');
    assert.match(pinned.pinnedHash ?? '', /^[a-f0-9]{64}$/);
    assert.match((await registry.resolve('example')).instructions, /Follow these instructions/);

    await writeFile(skillFile, '---\nname: example\ndescription: Changed\n---\n\nChanged instructions.\n');
    await assert.rejects(registry.resolve('example'), /pin/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skill registry rejects imports outside configured roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-skills-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'kiancode-skills-outside-'));
  try {
    await writeFile(path.join(outside, 'SKILL.md'), '---\nname: outside\ndescription: Outside\n---\nbody\n');
    const registry = new SkillRegistry({ manifestPath: path.join(root, 'manifest.json'), importRoots: [root] });
    await assert.rejects(registry.importSkill(outside), /outside/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
