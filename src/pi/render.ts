/**
 * Renders the surviving conversation as text for pi's compaction entry. Pi
 * stores one string in place of the messages it drops, so the "summary" this
 * plugin hands it is the conversation itself: nothing is rewritten, and tool
 * output is reproduced in full (pi's own serializer cuts results at 2000
 * characters, which is exactly the loss this plugin exists to avoid).
 */
import type { Message as CoreMessage } from '../core/types.ts';

export const VERBATIM_HEADER = [
  'This block is NOT a summary. It is the earlier part of this conversation',
  'itself, verbatim and in the original order. A scoring model was asked, for',
  'every tool call, whether the call and whether its full output are still',
  'needed; only the ones it let go were removed, and some outputs were cut to',
  'their first characters with a note saying so. Nothing here was rewritten,',
  'paraphrased or condensed, so it can be read and quoted as what was actually',
  'said and done. Any tool whose output was removed can simply be run again.',
].join('\n');

function toolCallLine(tool: string, input: Record<string, unknown>): string {
  let args: string;
  try {
    args = JSON.stringify(input);
  } catch {
    args = '[unserializable input]';
  }
  return `${tool}(${args})`;
}

export function renderVerbatim(
  messages: readonly CoreMessage[],
  previousSummary?: string,
): string {
  const parts: string[] = [VERBATIM_HEADER];
  if (previousSummary && previousSummary.trim().length > 0) {
    parts.push(`<earlier-summary>\n${previousSummary}\n</earlier-summary>`);
  }
  for (const message of messages) {
    const label = message.role === 'user' ? 'User' : 'Assistant';
    if (message.text.trim().length > 0) parts.push(`[${label}]: ${message.text}`);
    if (message.toolUses.length > 0) {
      parts.push(
        `[Assistant tool calls]: ${message.toolUses
          .map((tool) => toolCallLine(tool.tool, tool.input))
          .join('; ')}`,
      );
    }
    for (const result of message.toolResults ?? []) {
      parts.push(`[Tool result${result.isError ? ' (error)' : ''}]: ${result.text}`);
    }
  }
  return parts.join('\n\n');
}
