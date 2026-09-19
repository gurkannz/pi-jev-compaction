/**
 * Maps pi's `AgentMessage` list onto the neutral transcript shape the Jev core
 * works with. The mapping is one message in, one message out, so an index into
 * one array means the same position in the other; nothing is dropped, merged or
 * reordered. Only Jev ever sees the result — pi's own messages are pruned by
 * `prune.ts`, never rebuilt from this.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';

import type { Message as CoreMessage, ToolUse } from '../core/types.ts';

/** Stands in for an image block, which has no place in a text transcript. */
export const IMAGE_NOTE = '[image]';

function blocksToText(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : IMAGE_NOTE))
    .join('\n');
}

function assistantToCore(message: AssistantMessage): CoreMessage {
  const text = message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const toolUses: ToolUse[] = message.content
    .filter((block) => block.type === 'toolCall')
    .map((block) => ({
      tool_use_id: block.id,
      tool: block.name,
      input: block.arguments ?? {},
    }));
  return { role: 'assistant', text, toolUses };
}

function toolResultToCore(message: ToolResultMessage): CoreMessage {
  return {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [
      {
        tool_use_id: message.toolCallId,
        text: blocksToText(message.content),
        isError: message.isError,
      },
    ],
  };
}

/** Pi's own message types that are neither user, assistant nor tool result. */
function customToText(message: AgentMessage): string {
  const custom = message as unknown as Record<string, unknown>;
  switch (message.role) {
    case 'bashExecution':
      return custom['excludeFromContext']
        ? ''
        : `$ ${String(custom['command'] ?? '')}\n${String(custom['output'] ?? '')}`;
    case 'branchSummary':
    case 'compactionSummary':
      return String(custom['summary'] ?? '');
    case 'custom':
      return blocksToText(
        (custom['content'] as string | (TextContent | ImageContent)[] | undefined) ?? '',
      );
    default:
      return '';
  }
}

export function toCoreMessage(message: AgentMessage): CoreMessage {
  if (message.role === 'assistant') return assistantToCore(message as AssistantMessage);
  if (message.role === 'toolResult') return toolResultToCore(message as ToolResultMessage);
  if (message.role === 'user') {
    return { role: 'user', text: blocksToText((message as UserMessage).content), toolUses: [] };
  }
  return { role: 'user', text: customToText(message), toolUses: [] };
}

export function toCoreMessages(messages: readonly AgentMessage[]): CoreMessage[] {
  return messages.map(toCoreMessage);
}

/** The ids of every tool call made in these messages. */
export function toolCallIdsIn(messages: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of (message as AssistantMessage).content) {
      if (block.type === 'toolCall') ids.add(block.id);
    }
  }
  return ids;
}
