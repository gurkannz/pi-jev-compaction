/**
 * Applies Jev's decisions to pi's own messages. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and a note.
 * Messages that are not touched are returned as the objects they came in as.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, TextContent, ToolResultMessage } from '@earendil-works/pi-ai';

import { truncatedResultText } from '../core/compact.ts';
import type { CallDecision, ToolCall } from '../core/types.ts';
import { IMAGE_NOTE } from './messages.ts';

export type PruneAction = 'drop_call' | 'drop_result';

/** The decisions that change something, keyed by the tool call id pi uses. */
export function actionsFor(
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
): Map<string, PruneAction> {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, PruneAction>();
  for (const decision of decisions) {
    if (decision.action === 'keep') continue;
    const call = byId.get(decision.id);
    if (call) actions.set(call.tool_use_id, decision.action);
  }
  return actions;
}

/** An assistant message is worth keeping while it still says or does something. */
function carriesContent(content: AssistantMessage['content']): boolean {
  return content.some(
    (block) =>
      block.type === 'toolCall' || (block.type === 'text' && block.text.trim().length > 0),
  );
}

function truncatedContent(
  message: ToolResultMessage,
  headChars: number,
): ToolResultMessage['content'] | undefined {
  const text = message.content
    .map((block) => (block.type === 'text' ? block.text : IMAGE_NOTE))
    .join('\n');
  const truncated = truncatedResultText(text, message.isError, headChars);
  const onlyText = message.content.every((block) => block.type === 'text');
  if (truncated === text && onlyText) return undefined;
  const block: TextContent = { type: 'text', text: truncated };
  return [block];
}

export function pruneAgentMessages(
  messages: readonly AgentMessage[],
  actions: ReadonlyMap<string, PruneAction>,
  headChars: number,
): AgentMessage[] {
  if (actions.size === 0) return [...messages];
  const kept: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const assistant = message as AssistantMessage;
      const drops = assistant.content.some(
        (block) => block.type === 'toolCall' && actions.get(block.id) === 'drop_call',
      );
      if (!drops) {
        kept.push(message);
        continue;
      }
      const content = assistant.content.filter(
        (block) => !(block.type === 'toolCall' && actions.get(block.id) === 'drop_call'),
      );
      if (!carriesContent(content)) continue;
      kept.push({ ...assistant, content });
      continue;
    }
    if (message.role === 'toolResult') {
      const result = message as ToolResultMessage;
      const action = actions.get(result.toolCallId);
      if (action === 'drop_call') continue;
      if (action !== 'drop_result') {
        kept.push(message);
        continue;
      }
      const content = truncatedContent(result, headChars);
      kept.push(content ? { ...result, content } : message);
      continue;
    }
    kept.push(message);
  }
  return kept;
}
