/**
 * Plugin settings. Pi has no per-package option manifest, so the settings live
 * in `jev-compaction.json` next to pi's own settings, with the project copy
 * layered over the global one and a couple of environment overrides on top.
 * `mode` is the one option meant to be changed mid-session, through `/jev`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `off`: pi's own compaction. `compact`: only at compaction time. `always`: prune every turn too. */
export type JevMode = 'off' | 'compact' | 'always';

export const MODES: readonly JevMode[] = ['off', 'compact', 'always'];

export interface JevConfig {
  mode: JevMode;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  /** Below this share of characters saved, pi's own summary is used instead. */
  minReductionRatio: number;
  /** Context percentage from which `always` mode starts pruning. */
  triggerPercent: number;
  /** A verbatim history larger than this falls back to pi's own summary. */
  maxSummaryTokens: number;
}

export const DEFAULT_CONFIG: JevConfig = {
  mode: 'compact',
  model: 'jev-latest',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  minReductionRatio: 0.25,
  triggerPercent: 60,
  maxSummaryTokens: 24_000,
};

export const CONFIG_FILE = 'jev-compaction.json';

type Env = Record<string, string | undefined>;

/** Pi's agent directory, resolved the same way pi resolves it. */
export function agentDir(env: Env = process.env): string {
  const configured = env['PI_CODING_AGENT_DIR'];
  if (configured) return configured;
  return join(homedir(), '.pi', 'agent');
}

export function globalConfigPath(env: Env = process.env): string {
  return join(agentDir(env), CONFIG_FILE);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, '.pi', CONFIG_FILE);
}

export interface LoadedConfig {
  config: JevConfig;
  /** The files that were actually read, oldest precedence first. */
  files: string[];
  warnings: string[];
}

function readFile(path: string, warnings: string[]): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    warnings.push(`${path}: not a JSON object, ignored`);
  } catch {
    warnings.push(`${path}: malformed JSON, ignored`);
  }
  return undefined;
}

function isMode(value: unknown): value is JevMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

function merge(config: JevConfig, source: Record<string, unknown>, warnings: string[]): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === 'mode') {
      if (isMode(value)) config.mode = value;
      else warnings.push(`mode: ${String(value)} is not one of ${MODES.join(', ')}`);
      continue;
    }
    if (key === 'apiKey' || key === 'baseUrl' || key === 'model') {
      if (typeof value === 'string' && value.length > 0) config[key] = value;
      continue;
    }
    if (key in DEFAULT_CONFIG && typeof value === 'number' && Number.isFinite(value)) {
      (config as unknown as Record<string, number>)[key] = value;
    }
  }
}

export function loadConfig(cwd: string, env: Env = process.env): LoadedConfig {
  const config: JevConfig = { ...DEFAULT_CONFIG };
  const warnings: string[] = [];
  const files: string[] = [];
  for (const path of [globalConfigPath(env), projectConfigPath(cwd)]) {
    const source = readFile(path, warnings);
    if (!source) continue;
    files.push(path);
    merge(config, source, warnings);
  }
  const key = env['TYPESAFE_API_KEY'];
  if (key) config.apiKey = key;
  const mode = env['PI_JEV_MODE'];
  if (mode) {
    if (isMode(mode)) config.mode = mode;
    else warnings.push(`PI_JEV_MODE: ${mode} is not one of ${MODES.join(', ')}`);
  }
  return { config, files, warnings };
}

/** Writes just `mode` back, leaving everything else in the file untouched. */
export function saveMode(mode: JevMode, path: string): void {
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object') current = parsed as Record<string, unknown>;
  } catch {
    current = {};
  }
  writeFileSync(path, `${JSON.stringify({ ...current, mode }, null, 2)}\n`, 'utf8');
}
