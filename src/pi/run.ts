/**
 * One Jev pass over a list of pi messages: score every tool call that is still
 * a candidate, then hand back both the decisions and the map `prune.ts` needs.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { compact, reductionRatio } from '../core/compact.ts';
import { buildJevRequest, parseJevResponse } from '../core/request.ts';
import { collectToolCalls } from '../core/state.ts';
import type { CompactOptions, CompactResult, JevAsker, ToolCall } from '../core/types.ts';
import type { JevConfig } from './config.ts';
import { toCoreMessages } from './messages.ts';
import { actionsFor, type PruneAction } from './prune.ts';

export interface ScoredPass {
  result: CompactResult;
  actions: Map<string, PruneAction>;
}

/** Talks to Jev over `fetch`, honouring pi's abort signal. */
export function askerFor(config: JevConfig, signal?: AbortSignal): JevAsker {
  return {
    async ask(state, questions) {
      if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
      const request = buildJevRequest(
        { apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl },
        state,
        questions,
      );
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal,
      });
      return parseJevResponse(response.status, response.ok, await response.text());
    },
  };
}

export function coreOptions(
  config: JevConfig,
  candidate?: (call: ToolCall) => boolean,
): CompactOptions {
  const options: CompactOptions = {
    keepThreshold: config.keepThreshold,
    preserveRecentMessages: config.preserveRecentMessages,
    maxStateTokens: config.maxStateTokens,
    maxRequestTokens: config.maxRequestTokens,
    truncateHeadChars: config.truncateHeadChars,
  };
  if (candidate) options.candidate = candidate;
  return options;
}

/**
 * The calls a pass would actually ask about: paired with a result and outside
 * the pinned first and newest messages. A message that carries no call still
 * changes this set, because it pushes older calls out of the pinned window.
 */
export function candidateIds(
  messages: readonly AgentMessage[],
  preserveRecentMessages: number,
): string[] {
  return collectToolCalls(toCoreMessages(messages), preserveRecentMessages)
    .filter((call) => !call.pinned)
    .map((call) => call.tool_use_id);
}

export async function scorePass(
  messages: readonly AgentMessage[],
  asker: JevAsker,
  options: CompactOptions,
): Promise<ScoredPass> {
  const result = await compact(toCoreMessages(messages), asker, options);
  return { result, actions: actionsFor(result.decisions, result.calls) };
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} smaller; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s), ${stats.ms}ms`;
}
