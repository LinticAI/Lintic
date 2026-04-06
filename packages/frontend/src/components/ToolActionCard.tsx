import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, FileCode, Search, Terminal, FileSearch } from 'lucide-react';

// ─── Local types ─────────────────────────────────────────────────────────────

export interface LocalToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LocalToolResult {
  tool_call_id: string;
  name: string;
  output: string;
  is_error: boolean;
}

export interface LocalToolAction {
  description?: string | null;
  tool_calls: LocalToolCall[];
  tool_results: LocalToolResult[];
}

const OUTPUT_MAX_CHARS = 1000;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= OUTPUT_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, OUTPUT_MAX_CHARS), truncated: true };
}

function DiffPreview({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div data-testid="tool-action-diff" className="max-w-full overflow-x-auto">
      <div className="min-w-fit font-mono text-[12px] leading-relaxed">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre text-[var(--color-status-diff-add)] opacity-90">
            {'+ '}{line}
          </div>
        ))}
      </div>
    </div>
  );
}

function CommandOutput({ output }: { output: string }) {
  const { text, truncated } = truncate(output);
  return (
    <pre
      data-testid="tool-action-result"
      className="max-w-full overflow-x-auto font-mono text-[12px] text-[var(--color-text-main)] opacity-80 whitespace-pre"
    >
      {text}
      {truncated && <span className="opacity-40">{'\n'}…(truncated)</span>}
    </pre>
  );
}

function SingleToolCard({ call, result }: { call: LocalToolCall; result: LocalToolResult | undefined }) {
  const [open, setOpen] = useState(false);
  const isError = result?.is_error ?? false;

  let mainParam = '';
  if (call.name === 'write_file' || call.name === 'read_file') {
    mainParam = (call.input['path'] as string) || '';
  } else if (call.name === 'run_command' || call.name === 'run_shell_command' || call.name === 'run_command_background') {
    mainParam = (call.input['command'] as string) || '';
  } else if (call.name === 'search_files' || call.name === 'grep_search') {
    mainParam = (call.input['pattern'] as string) || '';
  } else if (call.name === 'list_directory') {
    mainParam = (call.input['dir_path'] as string) || '';
  }

  const displayName = call.name
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  const getIcon = () => {
    if (call.name.includes('file')) return <FileCode size={13} />;
    if (call.name.includes('search')) return <Search size={13} />;
    if (call.name.includes('command') || call.name.includes('shell')) return <Terminal size={13} />;
    return <FileSearch size={13} />;
  };

  return (
    <div data-testid="tool-action-card" className="flex flex-col mb-1 last:mb-0">
      <button
        type="button"
        data-testid="tool-action-toggle"
        onClick={() => setOpen((v) => !v)}
        className="group w-full flex items-center justify-between py-1 transition-colors"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-white/20 group-hover:text-white/40 flex items-center shrink-0 transition-colors">
            {getIcon()}
          </span>
          <div className="flex items-center gap-2 truncate">
            <span className="text-[12px] font-bold text-white/70 group-hover:text-white tracking-tight shrink-0 transition-colors">
              {displayName}:
            </span>
            {mainParam && (
              <span className="text-[12px] text-white/30 truncate font-medium tracking-tight group-hover:text-white/40">
                {mainParam}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {isError && (
            <span
              data-testid="tool-action-error-badge"
              className="text-[10px] text-[var(--color-status-error)] font-bold tracking-tight uppercase"
            >
              Error
            </span>
          )}
          <ChevronDown 
            size={13} 
            className={`transition-transform duration-300 text-white/10 group-hover:text-white/30 ${open ? 'rotate-180' : ''}`} 
          />
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div
              data-testid="tool-action-body"
              className="pl-6 pr-2 pb-3 space-y-3 opacity-70"
            >
              {/* Detailed Input */}
              <div className="space-y-2">
                {Object.entries(call.input).map(([k, v]) => (
                  <div key={k} className="space-y-1">
                    <span className="text-[9px] font-bold tracking-widest text-white/10 px-0.5 uppercase">
                      {k}
                    </span>
                    <div className="max-w-full overflow-x-auto px-1 font-mono text-[11px] text-white/50 leading-relaxed whitespace-pre">
                      {typeof v === 'string' ? v : JSON.stringify(v, null, 2)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Result Output */}
              {result !== undefined && (
                <div className="pt-3 border-t border-white/5">
                  <span className="text-[9px] font-bold tracking-widest text-white/10 block mb-1.5 px-0.5 uppercase">
                    Output
                  </span>
                  <div className="px-1">
                    {(call.name === 'write_file' || call.name === 'replace') && !isError ? (
                      <DiffPreview content={(result.output === 'ok' || result.output.startsWith('Successfully')) ? ((call.input['content'] as string) || (call.input['new_string'] as string) || '') : result.output} />
                    ) : (
                      <CommandOutput output={result.output} />
                    )}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function ToolActionCard({ action }: { action: LocalToolAction | LocalToolAction[] }) {
  const [showAll, setShowAll] = useState(false);
  const actions = Array.isArray(action) ? action : [action];
  
  // Flatten all tool calls across all actions
  const allCalls = actions.flatMap((a, actionIndex) => a.tool_calls.map((call, callIndex) => ({
    actionIndex,
    callIndex,
    description: a.description,
    call,
    result: a.tool_results.find(r => r.tool_call_id === call.id)
  })));

  const limit = 3;
  const hasMore = allCalls.length > limit;
  const visibleCalls = showAll ? allCalls : allCalls.slice(0, limit);

  return (
    <div className="w-full flex flex-col">
      {visibleCalls.map(({ actionIndex, callIndex, description, call, result }) => (
        <div key={call.id} className="flex flex-col">
          {callIndex === 0 && description && (
            <div
              data-testid="tool-action-description"
              className="mb-1 px-5 text-[12px] text-white/45 leading-relaxed"
            >
              {description}
            </div>
          )}
          <SingleToolCard call={call} result={result} />
          {showAll && actionIndex < actions.length - 1 && callIndex === actions[actionIndex]!.tool_calls.length - 1 ? (
            <div className="h-2" />
          ) : null}
        </div>
      ))}
      
      {hasMore && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="group w-full flex items-center py-1 transition-colors"
        >
          <span className="text-[12px] text-white/20 group-hover:text-white/40 pl-5">
            {showAll ? '— show less' : `+ ${allCalls.length - limit} more tool uses`}
          </span>
        </button>
      )}
    </div>
  );
}
