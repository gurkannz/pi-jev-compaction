/**
 * Verbatim context compaction for pi, scored by TypeSafe's Jev model.
 *
 * Two places can prune, and `/jev` switches between them at any time:
 *
 * - `compact`  only `session_before_compact`. When pi would summarise the old
 *              part of the session, Jev is asked per tool call whether the call
 *              and whether its full output are still needed, and what survives
 *              is handed back to pi as text, verbatim. No LLM summary is made.
 * - `always`   the above plus `context`: before every LLM call the same
 *              decisions are applied to the live message list, so tool output
 *              that has gone stale leaves the context without waiting for a
 *              compaction. Scoring happens in the background, between turns.
 *
 * Anything that fails, or that does not save enough, falls back to pi's own
 * summary. User and assistant text is never removed or rewritten.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  buildContextEntries,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { reductionRatio } from '../src/core/compact.ts';
import { estimateTokens } from '../src/core/state.ts';
import {
  globalConfigPath,
  loadConfig,
  MODES,
  saveMode,
  type JevConfig,
  type JevMode,
} from '../src/pi/config.ts';
import { fileLists, type FileOperations } from '../src/pi/files.ts';
import { toCoreMessages, toolCallIdsIn } from '../src/pi/messages.ts';
import { pruneAgentMessages, type PruneAction } from '../src/pi/prune.ts';
import { renderVerbatim } from '../src/pi/render.ts';
import {
  askerFor,
  candidateIds,
  coreOptions,
  percent,
  scorePass,
  summarize,
} from '../src/pi/run.ts';

export default function jevCompaction(pi: ExtensionAPI): void {
  let config: JevConfig | undefined;
  let warnings: string[] = [];
  let configFile = '';

  /** Decisions taken so far this session; a drop is never taken back. */
  const decided = new Map<string, PruneAction>();
  let scoring = false;
  let lastSignature = '';
  let lastPass: string | undefined;
  let lastError: string | undefined;

  function settings(ctx: { cwd: string }): JevConfig {
    if (!config) {
      const loaded = loadConfig(ctx.cwd);
      config = loaded.config;
      warnings = loaded.warnings;
      configFile = loaded.files[loaded.files.length - 1] ?? globalConfigPath();
    }
    return config;
  }

  function notify(ctx: ExtensionContext, text: string, type: 'info' | 'warning' | 'error'): void {
    try {
      ctx.ui.notify(`jev: ${text}`, type);
    } catch {
      // The session can be gone by the time a background pass reports.
    }
  }

  function status(ctx: ExtensionContext, text: string | undefined): void {
    try {
      ctx.ui.setStatus('jev', text);
    } catch {
      // Same.
    }
  }

  /**
   * Scores the context in the background, so no turn waits for Jev. Whether a
   * pass is due is decided from the session as it stands, not from the pruned
   * view: pruning changes which calls are left, so a pass would otherwise
   * always look like a reason for the next one.
   */
  function startPass(
    session: readonly AgentMessage[],
    pruned: readonly AgentMessage[],
    cfg: JevConfig,
    ctx: ExtensionContext,
  ): void {
    if (scoring) return;
    const usage = ctx.getContextUsage();
    if ((usage?.percent ?? 0) < cfg.triggerPercent) return;
    const candidates = candidateIds(session, cfg.preserveRecentMessages).join(',');
    if (candidates.length === 0 || candidates === lastSignature) return;
    scoring = true;
    lastSignature = candidates;
    const snapshot = [...pruned];
    void (async () => {
      try {
        const pass = await scorePass(snapshot, askerFor(cfg), coreOptions(cfg));
        for (const [id, action] of pass.actions) decided.set(id, action);
        lastPass = summarize(pass.result);
        lastError = undefined;
        if (pass.actions.size > 0) status(ctx, `jev -${percent(reductionRatio(pass.result))}`);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        status(ctx, 'jev failed');
        notify(ctx, `pruning failed, context left as is (${lastError})`, 'warning');
      } finally {
        scoring = false;
      }
    })();
  }

  pi.on('session_start', async (_event, ctx) => {
    const cfg = settings(ctx);
    for (const warning of warnings) notify(ctx, warning, 'warning');
    if (cfg.mode !== 'off' && !cfg.apiKey) {
      notify(ctx, 'no TypeSafe API key, pi will summarise on its own', 'warning');
    }
  });

  pi.on('session_shutdown', async () => {
    decided.clear();
    lastSignature = '';
  });

  pi.on('context', (event, ctx) => {
    const cfg = settings(ctx);
    if (cfg.mode !== 'always') return;
    const pruned =
      decided.size > 0
        ? pruneAgentMessages(event.messages, decided, cfg.truncateHeadChars)
        : undefined;
    startPass(event.messages, pruned ?? event.messages, cfg, ctx);
    return pruned ? { messages: pruned } : undefined;
  });

  pi.on('session_before_compact', async (event, ctx) => {
    const cfg = settings(ctx);
    if (cfg.mode === 'off') return;
    const { preparation, branchEntries, signal } = event;
    const span = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
    const candidates = toolCallIdsIn(span);
    if (candidates.size === 0) {
      notify(ctx, 'no tool calls in the old messages, pi summarises them', 'info');
      return;
    }
    try {
      const branch = buildContextEntries([...branchEntries]).flatMap(sessionEntryToContextMessages);
      const pass = await scorePass(
        branch.length > 0 ? branch : span,
        askerFor(cfg, signal),
        coreOptions(cfg, (call) => candidates.has(call.tool_use_id)),
      );
      for (const [id, action] of pass.actions) decided.set(id, action);
      const pruned = pruneAgentMessages(span, pass.actions, cfg.truncateHeadChars);
      const before = renderVerbatim(toCoreMessages(span));
      const summary = renderVerbatim(toCoreMessages(pruned), preparation.previousSummary);
      const ratio = before.length === 0 ? 0 : (before.length - summary.length) / before.length;
      lastPass = summarize(pass.result);
      lastError = undefined;

      const tokens = estimateTokens(summary);
      if (tokens > cfg.maxSummaryTokens) {
        notify(
          ctx,
          `verbatim history is ~${tokens} tokens, over the ${cfg.maxSummaryTokens} limit; pi summarises instead`,
          'warning',
        );
        return;
      }
      if (ratio < cfg.minReductionRatio) {
        notify(
          ctx,
          `only ${percent(ratio)} smaller, under the ${percent(cfg.minReductionRatio)} minimum; pi summarises instead`,
          'info',
        );
        return;
      }
      notify(ctx, `history kept verbatim, ${percent(ratio)} smaller (${lastPass})`, 'info');
      status(ctx, `jev -${percent(ratio)}`);
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            ...fileLists(preparation.fileOps as FileOperations),
            jev: pass.result.stats,
          },
        },
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      notify(ctx, `pi summarises instead (${lastError})`, 'warning');
      return;
    }
  });

  pi.registerCommand('jev', {
    description: 'Jev compaction: show status, or set the mode (off, compact, always)',
    getArgumentCompletions: (prefix) => {
      const matches = MODES.filter((mode) => mode.startsWith(prefix));
      return matches.length > 0 ? matches.map((mode) => ({ value: mode, label: mode })) : null;
    },
    handler: async (args, ctx) => {
      const cfg = settings(ctx);
      const argument = args.trim();
      if (argument.length > 0 && argument !== 'status') {
        if (!(MODES as readonly string[]).includes(argument)) {
          notify(ctx, `unknown mode ${argument}; use ${MODES.join(', ')}`, 'error');
          return;
        }
        cfg.mode = argument as JevMode;
        try {
          saveMode(cfg.mode, globalConfigPath());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notify(ctx, `mode set for this session only (${message})`, 'warning');
          return;
        }
        if (cfg.mode !== 'always') status(ctx, undefined);
        notify(
          ctx,
          cfg.mode === 'off'
            ? 'off, pi compacts on its own'
            : cfg.mode === 'compact'
              ? 'on at compaction time only'
              : `on every turn from ${cfg.triggerPercent}% context, and at compaction time`,
          'info',
        );
        return;
      }
      const usage = ctx.getContextUsage();
      const context =
        usage === undefined || usage.percent === null ? 'unknown' : `${Math.round(usage.percent)}%`;
      const lines = [
        `mode ${cfg.mode}, key ${cfg.apiKey ? 'set' : 'missing'}, threshold ${cfg.keepThreshold}`,
        `context ${context}, prunes from ${cfg.triggerPercent}%, ${decided.size} call(s) let go so far`,
        lastPass ? `last pass: ${lastPass}` : 'no pass yet',
        lastError ? `last error: ${lastError}` : '',
        `settings: ${configFile}`,
      ].filter(Boolean);
      notify(ctx, lines.join('\n'), lastError ? 'warning' : 'info');
    },
  });
}
