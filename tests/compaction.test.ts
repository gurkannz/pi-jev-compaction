import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { toCoreMessages, toolCallIdsIn } from '../src/pi/messages.ts';
import { pruneAgentMessages, type PruneAction } from '../src/pi/prune.ts';
import { renderVerbatim, VERBATIM_HEADER } from '../src/pi/render.ts';
import { coreOptions, scorePass } from '../src/pi/run.ts';
import { DEFAULT_CONFIG } from '../src/pi/config.ts';
import { assistant, fakeJev, toolResult, user } from './helpers.ts';

const LONG = 'x'.repeat(1000);

function session(): AgentMessage[] {
  return [
    user('Fix the failing parser test. Do not touch legacy/.'),
    assistant('Looking at the tree.', [{ id: 'c1', name: 'ls', arguments: { path: 'src' } }]),
    toolResult('c1', LONG),
    assistant('', [{ id: 'c2', name: 'read', arguments: { file_path: 'src/parser.ts' } }]),
    toolResult('c2', LONG),
    assistant('', [{ id: 'c3', name: 'bash', arguments: { command: 'npm test' } }]),
    toolResult('c3', 'PASS'),
    user('Great, now add a changelog entry.'),
  ];
}

describe('message mapping', () => {
  it('maps every pi message to exactly one transcript message', () => {
    const messages = session();
    const core = toCoreMessages(messages);
    expect(core).toHaveLength(messages.length);
    expect(core[0]).toEqual({
      role: 'user',
      text: 'Fix the failing parser test. Do not touch legacy/.',
      toolUses: [],
    });
    expect(core[1]?.toolUses).toEqual([
      { tool_use_id: 'c1', tool: 'ls', input: { path: 'src' } },
    ]);
    expect(core[2]?.toolResults).toEqual([
      { tool_use_id: 'c1', text: LONG, isError: false },
    ]);
  });

  it('renders pi-only message types as plain text', () => {
    const bash = {
      role: 'bashExecution',
      command: 'git status',
      output: 'clean',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    } as unknown as AgentMessage;
    expect(toCoreMessages([bash])[0]).toEqual({
      role: 'user',
      text: '$ git status\nclean',
      toolUses: [],
    });
  });

  it('collects the tool call ids of a span', () => {
    expect([...toolCallIdsIn(session())]).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('pruning pi messages', () => {
  const actions = new Map<string, PruneAction>([
    ['c1', 'drop_call'],
    ['c2', 'drop_result'],
  ]);

  it('drops a call together with its result, and truncates a dropped result', () => {
    const messages = session();
    const pruned = pruneAgentMessages(messages, actions, DEFAULT_CONFIG.truncateHeadChars);

    expect(toolCallIdsIn(pruned)).toEqual(new Set(['c2', 'c3']));
    expect(pruned.some((m) => m.role === 'toolResult' && (m as ToolResultMessage).toolCallId === 'c1')).toBe(false);

    const kept = pruned.find(
      (m) => m.role === 'toolResult' && (m as ToolResultMessage).toolCallId === 'c2',
    ) as ToolResultMessage;
    const text = kept.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text.startsWith('x'.repeat(DEFAULT_CONFIG.truncateHeadChars))).toBe(true);
    expect(text).toContain('jev-compaction truncated 700 chars');
    expect(text.length).toBeLessThan(LONG.length);
  });

  it('keeps the assistant text of a message whose call was dropped', () => {
    const messages = session();
    const pruned = pruneAgentMessages(messages, actions, DEFAULT_CONFIG.truncateHeadChars);
    const spoken = pruned.filter(
      (m) => m.role === 'assistant' && (m as AssistantMessage).content.some((b) => b.type === 'text'),
    );
    expect(spoken).toHaveLength(1);
    expect(((spoken[0] as AssistantMessage).content[0] as { text: string }).text).toBe(
      'Looking at the tree.',
    );
  });

  it('returns untouched messages as the very same objects', () => {
    const messages = session();
    const pruned = pruneAgentMessages(messages, actions, DEFAULT_CONFIG.truncateHeadChars);
    expect(pruned).toContain(messages[0]);
    expect(pruned).toContain(messages[7]);
  });

  it('leaves everything alone when there is nothing to do', () => {
    const messages = session();
    expect(pruneAgentMessages(messages, new Map(), 300)).toEqual(messages);
  });
});

describe('verbatim rendering', () => {
  it('reproduces tool output in full and says it is not a summary', () => {
    const text = renderVerbatim(toCoreMessages(session()));
    expect(text.startsWith(VERBATIM_HEADER)).toBe(true);
    expect(text).toContain('[Assistant tool calls]: ls({"path":"src"})');
    expect(text).toContain(LONG);
    expect(text).toContain('Fix the failing parser test.');
  });

  it('carries an earlier summary forward', () => {
    const text = renderVerbatim(toCoreMessages([user('hi')]), 'what happened before');
    expect(text).toContain('<earlier-summary>\nwhat happened before\n</earlier-summary>');
  });
});

describe('scoring a pass', () => {
  const config = { ...DEFAULT_CONFIG, preserveRecentMessages: 2 };

  it('asks two questions per candidate call and leaves pinned ones alone', async () => {
    const jev = fakeJev({ t1: { call: 0.1, result: 0.1 }, t2: { call: 0.9, result: 0.1 } });
    const pass = await scorePass(session(), jev, coreOptions(config));

    expect(jev.asked.sort()).toEqual(['call_t1', 'call_t2', 'result_t1', 'result_t2']);
    expect(pass.actions).toEqual(
      new Map([
        ['c1', 'drop_call'],
        ['c2', 'drop_result'],
      ]),
    );
    expect(pass.result.stats.pinned).toBe(1);
    expect(pass.result.stats.callsDropped).toBe(1);
    expect(pass.result.stats.resultsDropped).toBe(1);
  });

  it('never leaves a result without its call, or a call without its result', async () => {
    const jev = fakeJev({ t1: { call: 0.1, result: 0.1 }, t2: { call: 0.1, result: 0.1 } });
    const pass = await scorePass(session(), jev, coreOptions(config));
    const pruned = pruneAgentMessages(session(), pass.actions, config.truncateHeadChars);

    const calls = toolCallIdsIn(pruned);
    const results = new Set(
      pruned
        .filter((m) => m.role === 'toolResult')
        .map((m) => (m as ToolResultMessage).toolCallId),
    );
    expect([...calls].sort()).toEqual([...results].sort());
  });

  it('only asks about the calls a candidate filter allows', async () => {
    const jev = fakeJev({});
    const only = new Set(['c2']);
    await scorePass(session(), jev, coreOptions(config, (call) => only.has(call.tool_use_id)));
    expect(jev.asked.sort()).toEqual(['call_t2', 'result_t2']);
  });

  it('makes no request at all when every call is pinned', async () => {
    const jev = fakeJev({});
    const pass = await scorePass(session(), jev, coreOptions({ ...config, preserveRecentMessages: 99 }));
    expect(jev.asked).toEqual([]);
    expect(pass.actions.size).toBe(0);
    expect(pass.result.stats.requests).toBe(0);
  });
});
