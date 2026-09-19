/**
 * Drives the extension the way pi does: the registered handlers are called with
 * stub events, and Jev is answered at the `fetch` boundary, so the whole path
 * (settings, scoring, pruning, rendering, fallback) runs for real.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import jevCompaction from '../extensions/jev-compaction.ts';
import { CONFIG_FILE } from '../src/pi/config.ts';
import { toolCallIdsIn } from '../src/pi/messages.ts';
import { assistant, toolResult, user } from './helpers.ts';

const LONG = 'x'.repeat(1000);

type Handlers = Record<string, (event: unknown, ctx: unknown) => unknown>;

interface Harness {
  handlers: Handlers;
  command: { handler: (args: string, ctx: unknown) => Promise<void> };
  ctx: Record<string, unknown>;
  notices: string[];
  agent: string;
  jevCalls: () => number;
}

/** Every call stays, except the ones named here. */
let drops: Record<string, 'call' | 'result'> = {};
let requests = 0;

function answerJev(body: string): string {
  const questions = (JSON.parse(body) as { questions: Record<string, unknown> }).questions;
  const answers: Record<string, { noul: number }> = {};
  for (const name of Object.keys(questions)) {
    const kind = name.slice(0, name.indexOf('_'));
    const id = name.slice(name.indexOf('_') + 1);
    const drop = drops[id];
    const keep = drop === 'call' ? 0.1 : drop === 'result' ? (kind === 'call' ? 0.9 : 0.1) : 0.9;
    answers[name] = { noul: keep };
  }
  return JSON.stringify({ answers });
}

function setup(settings: Record<string, unknown> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'jev-ext-'));
  const agent = join(root, 'agent');
  const project = join(root, 'project');
  mkdirSync(agent);
  mkdirSync(project);
  writeFileSync(join(agent, CONFIG_FILE), JSON.stringify({ mode: 'compact', ...settings }));
  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');

  const handlers: Handlers = {};
  let command: Harness['command'] | undefined;
  jevCompaction({
    on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
      handlers[event] = handler;
    },
    registerCommand: (_name: string, options: Harness['command']) => {
      command = options;
    },
  } as never);

  const notices: string[] = [];
  const ctx = {
    cwd: project,
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: () => undefined,
    },
    getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000, percent: 90 }),
  };
  return { handlers, command: command!, ctx, notices, agent, jevCalls: () => requests };
}

function session(): AgentMessage[] {
  return [
    user('Fix the failing parser test. Do not touch legacy/.'),
    assistant('', [{ id: 'c1', name: 'read', arguments: { file_path: 'src/legacy.ts' } }]),
    toolResult('c1', LONG),
    assistant('', [{ id: 'c2', name: 'read', arguments: { file_path: 'src/parser.ts' } }]),
    toolResult('c2', LONG),
    assistant('', [{ id: 'c3', name: 'bash', arguments: { command: 'npm test' } }]),
    toolResult('c3', 'PASS'),
    user('Now add a changelog entry.'),
  ];
}

function compactEvent(messages: AgentMessage[]) {
  return {
    type: 'session_before_compact',
    preparation: {
      firstKeptEntryId: 'entry-7',
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 90_000,
      fileOps: { read: new Set(['src/parser.ts']), written: new Set(), edited: new Set(['src/parser.ts']) },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    },
    branchEntries: [],
    reason: 'threshold',
    willRetry: false,
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  drops = {};
  requests = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    requests += 1;
    return { ok: true, status: 200, text: async () => answerJev(init.body) };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('session_before_compact', () => {
  it('replaces the summary with the verbatim history minus what Jev let go', async () => {
    drops = { t1: 'call', t2: 'result' };
    const harness = setup({ preserveRecentMessages: 2 });
    const result = (await harness.handlers['session_before_compact']!(
      compactEvent(session()),
      harness.ctx,
    )) as { compaction: { summary: string; firstKeptEntryId: string; details: unknown } };

    expect(harness.jevCalls()).toBe(1);
    expect(result.compaction.firstKeptEntryId).toBe('entry-7');
    expect(result.compaction.summary).toContain('NOT a summary');
    expect(result.compaction.summary).toContain('Fix the failing parser test.');
    expect(result.compaction.summary).not.toContain('src/legacy.ts');
    expect(result.compaction.summary).toContain('jev-compaction truncated 700 chars');
    expect(result.compaction.details).toMatchObject({
      readFiles: [],
      modifiedFiles: ['src/parser.ts'],
    });
    expect(harness.notices.join(' ')).toContain('verbatim');
  });

  it('leaves compaction to pi when too little would be saved', async () => {
    const harness = setup({ preserveRecentMessages: 2 });
    const result = await harness.handlers['session_before_compact']!(
      compactEvent(session()),
      harness.ctx,
    );
    expect(result).toBeUndefined();
    expect(harness.notices.join(' ')).toContain('under the 25% minimum');
  });

  it('leaves compaction to pi when Jev fails', async () => {
    drops = { t1: 'call', t2: 'call' };
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    const harness = setup({ preserveRecentMessages: 2 });
    const result = await harness.handlers['session_before_compact']!(
      compactEvent(session()),
      harness.ctx,
    );
    expect(result).toBeUndefined();
    expect(harness.notices.join(' ')).toContain('500');
  });

  it('does nothing in off mode', async () => {
    const harness = setup({ mode: 'off' });
    const result = await harness.handlers['session_before_compact']!(
      compactEvent(session()),
      harness.ctx,
    );
    expect(result).toBeUndefined();
    expect(harness.jevCalls()).toBe(0);
  });
});

describe('context', () => {
  it('stays out of the way unless the mode is always', async () => {
    const harness = setup({ mode: 'compact' });
    const result = await harness.handlers['context']!(
      { type: 'context', messages: session() },
      harness.ctx,
    );
    expect(result).toBeUndefined();
    expect(harness.jevCalls()).toBe(0);
  });

  it('scores in the background and prunes the context from the next call on', async () => {
    drops = { t1: 'call', t2: 'result' };
    const harness = setup({ mode: 'always', preserveRecentMessages: 2, triggerPercent: 60 });

    const first = await harness.handlers['context']!(
      { type: 'context', messages: session() },
      harness.ctx,
    );
    expect(first).toBeUndefined();

    const second = (await vi.waitFor(async () => {
      const pruned = await harness.handlers['context']!(
        { type: 'context', messages: session() },
        harness.ctx,
      );
      expect(pruned).toBeDefined();
      return pruned;
    })) as { messages: AgentMessage[] };
    expect(harness.jevCalls()).toBe(1);
    expect(toolCallIdsIn(second.messages)).toEqual(new Set(['c2', 'c3']));
    const kept = second.messages.find(
      (m) => m.role === 'toolResult' && (m as ToolResultMessage).toolCallId === 'c2',
    ) as ToolResultMessage;
    expect((kept.content[0] as { text: string }).text).toContain('jev-compaction truncated');
  });

  it('waits until the context is actually full', async () => {
    const harness = setup({ mode: 'always', triggerPercent: 95 });
    await harness.handlers['context']!({ type: 'context', messages: session() }, harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.jevCalls()).toBe(0);
  });
});

describe('/jev', () => {
  it('switches mode for the session and writes it back to the settings file', async () => {
    const harness = setup({ mode: 'compact', preserveRecentMessages: 2 });
    await harness.command.handler('always', harness.ctx);

    const saved = JSON.parse(readFileSync(join(harness.agent, CONFIG_FILE), 'utf8')) as {
      mode: string;
    };
    expect(saved.mode).toBe('always');

    const result = await harness.handlers['context']!(
      { type: 'context', messages: session() },
      harness.ctx,
    );
    expect(result).toBeUndefined();
    await vi.waitFor(() => expect(harness.jevCalls()).toBe(1));
  });

  it('refuses a mode it does not know', async () => {
    const harness = setup();
    await harness.command.handler('sometimes', harness.ctx);
    expect(harness.notices.join(' ')).toContain('unknown mode sometimes');
  });

  it('reports the current state', async () => {
    const harness = setup({ mode: 'always' });
    await harness.command.handler('', harness.ctx);
    expect(harness.notices.join(' ')).toContain('mode always, key set');
    expect(harness.notices.join(' ')).toContain('no pass yet');
  });
});
