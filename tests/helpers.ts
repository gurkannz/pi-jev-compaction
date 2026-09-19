import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { JevAsker, JevQuestions } from '../src/core/types.ts';

export function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage;
}

export function assistant(
  text: string,
  calls: { id: string; name: string; arguments?: Record<string, unknown> }[] = [],
): AgentMessage {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...calls.map((call) => ({
        type: 'toolCall',
        id: call.id,
        name: call.name,
        arguments: call.arguments ?? {},
      })),
    ],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason: 'stop',
    timestamp: 1,
  } as unknown as AgentMessage;
}

export function toolResult(id: string, text: string, isError = false): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'test',
    content: [{ type: 'text', text }],
    isError,
    timestamp: 1,
  } as unknown as AgentMessage;
}

export type Answers = Record<string, { call: number; result: number }>;

/** A Jev that answers from a table, and records the questions it was asked. */
export function fakeJev(answers: Answers): JevAsker & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async ask(_state, questions: JevQuestions) {
      const given: Record<string, { noul: number }> = {};
      for (const name of Object.keys(questions)) {
        asked.push(name);
        const [kind, id] = [name.slice(0, name.indexOf('_')), name.slice(name.indexOf('_') + 1)];
        const answer = answers[id] ?? { call: 1, result: 1 };
        given[name] = { noul: kind === 'call' ? answer.call : answer.result };
      }
      return { answers: given };
    },
  };
}
