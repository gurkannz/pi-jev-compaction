import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  globalConfigPath,
  loadConfig,
  saveMode,
} from '../src/pi/config.ts';

function workspace(): { agent: string; project: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'jev-'));
  const agent = join(root, 'agent');
  const project = join(root, 'project');
  mkdirSync(agent);
  mkdirSync(join(project, '.pi'), { recursive: true });
  return { agent, project, env: { PI_CODING_AGENT_DIR: agent } };
}

describe('settings', () => {
  it('falls back to the defaults when nothing is configured', () => {
    const { project, env } = workspace();
    const { config, files, warnings } = loadConfig(project, env);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(files).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('layers the project file over the global one, and the environment over both', () => {
    const { agent, project, env } = workspace();
    writeFileSync(
      join(agent, CONFIG_FILE),
      JSON.stringify({ mode: 'always', keepThreshold: 0.7, truncateHeadChars: 100 }),
    );
    writeFileSync(join(project, '.pi', CONFIG_FILE), JSON.stringify({ keepThreshold: 0.4 }));

    const { config, files } = loadConfig(project, {
      ...env,
      TYPESAFE_API_KEY: 'secret',
      PI_JEV_MODE: 'compact',
    });
    expect(config.mode).toBe('compact');
    expect(config.keepThreshold).toBe(0.4);
    expect(config.truncateHeadChars).toBe(100);
    expect(config.apiKey).toBe('secret');
    expect(files).toHaveLength(2);
  });

  it('keeps going and says so when a value or a file is unusable', () => {
    const { agent, project, env } = workspace();
    writeFileSync(join(agent, CONFIG_FILE), '{ not json');
    writeFileSync(join(project, '.pi', CONFIG_FILE), JSON.stringify({ mode: 'sometimes' }));

    const { config, warnings } = loadConfig(project, env);
    expect(config.mode).toBe(DEFAULT_CONFIG.mode);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('malformed JSON');
    expect(warnings[1]).toContain('sometimes');
  });

  it('writes the mode back without losing the other settings', () => {
    const { agent, env } = workspace();
    const path = globalConfigPath(env);
    writeFileSync(path, JSON.stringify({ keepThreshold: 0.8 }));

    saveMode('always', path);
    expect(loadConfig(agent, env).config).toMatchObject({ mode: 'always', keepThreshold: 0.8 });
  });
});
