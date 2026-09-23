import { json } from '@codemirror/lang-json';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleHelp, Clipboard, Download, Loader2, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ipc } from '@/ipc/manager';
import type {
  TrafficAuditBodyDescriptor,
  TrafficAuditBodySearchResult,
} from '@/modules/proxy-gateway/audit/traffic-audit.types';

import { formatAuditBody } from './format-audit-body';

const PAGE_BYTES = 256 * 1024;
const PREVIEW_BYTES = 20 * 1024;
const INITIAL_BYTES = 1024 * 1024;
const MAX_VIEW_BYTES = 4 * 1024 * 1024;

interface AuditBodyViewerProps {
  body: TrafficAuditBodyDescriptor | null;
}

export function AuditBodyViewer({ body }: AuditBodyViewerProps) {
  return <AuditBodyViewerContent key={body?.id ?? 'none'} body={body} />;
}

function AuditBodyViewerContent({ body }: AuditBodyViewerProps) {
  const { t } = useTranslation();
  const active = useRef(true);
  const editor = useRef<EditorView | null>(null);
  const [content, setContent] = useState('');
  const [viewAll, setViewAll] = useState(false);
  const [cursor, setCursor] = useState<number | null>(0);
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'concise' | 'full'>(() =>
    localStorage.getItem('traffic-body-view-mode') === 'concise' ? 'concise' : 'full',
  );
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<TrafficAuditBodySearchResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [rawWindow, setRawWindow] = useState(false);
  const [jumpSelection, setJumpSelection] = useState<{ from: number; to: number } | null>(null);
  const loadedBytes = useMemo(() => new TextEncoder().encode(content).byteLength, [content]);
  const previewOnly = !viewAll && body !== null && body.storedBytes > PREVIEW_BYTES;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const loadUntil = useCallback(
    async (targetBytes: number, replaceWindow = false) => {
      if (!body || loading || complete || cursor === null) {
        return;
      }
      setLoading(true);
      try {
        let nextCursor: number | null = cursor;
        let loaded = replaceWindow ? '' : content;
        let bytesInWindow = replaceWindow ? 0 : loadedBytes;
        let done: boolean = complete;
        while (
          !done &&
          nextCursor !== null &&
          bytesInWindow < Math.min(targetBytes, MAX_VIEW_BYTES) &&
          active.current
        ) {
          const page = await ipc.client.gateway.auditBodyPage({
            bodyId: body.id,
            cursor: nextCursor,
            limitBytes: Math.min(PAGE_BYTES, targetBytes),
          });
          if (!page) {
            done = true;
            break;
          }
          const segment = page.chunks.map((chunk) => chunk.data).join('');
          loaded += segment;
          bytesInWindow += new TextEncoder().encode(segment).byteLength;
          nextCursor = page.nextCursor;
          done = page.complete;
        }
        if (active.current) {
          setContent(loaded);
          setRawWindow(false);
          setCursor(nextCursor);
          setComplete(done);
        }
      } finally {
        if (active.current) {
          setLoading(false);
        }
      }
    },
    [body, complete, content, cursor, loadedBytes, loading],
  );

  useEffect(() => {
    if (body && body.state !== 'expired' && content.length === 0 && !loading && !complete) {
      queueMicrotask(() => loadUntil(viewAll ? INITIAL_BYTES : PREVIEW_BYTES));
    }
  }, [body, complete, content.length, loadUntil, loading, viewAll]);

  const displayContent = useMemo(() => {
    if (previewOnly && content) {
      return `${utf8Prefix(content, PREVIEW_BYTES)}…`;
    }
    return rawWindow ? content : formatAuditBody(content, body?.kind ?? 'text', mode);
  }, [body?.kind, content, mode, previewOnly, rawWindow]);
  useEffect(() => {
    if (!jumpSelection || !editor.current || editor.current.state.doc.length < jumpSelection.to) {
      return;
    }
    const view = editor.current;
    view.dispatch({
      effects: EditorView.scrollIntoView(jumpSelection.from, { y: 'center' }),
      selection: { anchor: jumpSelection.from, head: jumpSelection.to },
    });
    setJumpSelection(null);
  }, [displayContent, jumpSelection]);
  const extensions = useMemo(() => {
    const result: Extension[] = [EditorView.lineWrapping];
    if (body?.kind === 'json' && !previewOnly) {
      result.push(json());
    }
    if (body?.parseErrorOffset !== null && body?.parseErrorOffset !== undefined) {
      const offset = body.parseErrorOffset;
      result.push(
        EditorView.decorations.compute([], (state) => {
          const position = Math.min(offset, state.doc.length);
          return Decoration.set([
            Decoration.line({ attributes: { class: 'cm-traffic-parse-error-line' } }).range(
              state.doc.lineAt(position).from,
            ),
          ]);
        }),
        EditorView.baseTheme({
          '.cm-traffic-parse-error-line': {
            backgroundColor: 'color-mix(in srgb, var(--destructive) 12%, transparent)',
            boxShadow: 'inset 3px 0 0 var(--destructive)',
          },
        }),
      );
    }
    return result;
  }, [body, previewOnly]);

  if (!body) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        {t('traffic.select-body')}
      </div>
    );
  }

  const loadMore = async () => {
    await loadUntil(MAX_VIEW_BYTES, loadedBytes >= MAX_VIEW_BYTES);
  };

  const jumpToMatch = async (match: TrafficAuditBodySearchResult['matches'][number]) => {
    const page = await ipc.client.gateway.auditBodyPage({
      bodyId: body.id,
      cursor: match.sequence,
      limitBytes: PAGE_BYTES,
    });
    if (!page || !active.current) {
      return;
    }
    setMode('full');
    setContent(page.chunks.map((chunk) => chunk.data).join(''));
    setRawWindow(true);
    setCursor(page.nextCursor);
    setComplete(page.complete);
    setJumpSelection({ from: match.chunkOffset, to: match.chunkOffset + match.length });
  };

  const copyLoaded = async () => {
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };

  const search = async () => {
    if (!query.trim()) {
      setSearchResult(null);
      return;
    }
    setSearchResult(
      await ipc.client.gateway.auditBodySearch({
        bodyId: body.id,
        limit: 100,
        query: query.trim(),
      }),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border">
      <div className="bg-muted/30 flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="bg-muted flex rounded-md p-0.5">
          {(['concise', 'full'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`rounded px-2.5 py-1 text-xs font-medium ${mode === value ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
              onClick={() => {
                setMode(value);
                localStorage.setItem('traffic-body-view-mode', value);
              }}
            >
              {value === 'concise' ? t('traffic.concise') : t('traffic.full')}
            </button>
          ))}
        </div>
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('traffic.view-mode-help')}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
              >
                <CircleHelp className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent side="bottom" align="start" className="max-w-80 space-y-1.5 text-xs">
                <p>{t('traffic.concise-help')}</p>
                <p>{t('traffic.full-help')}</p>
              </TooltipContent>
            </TooltipPortal>
          </Tooltip>
        </TooltipProvider>
        <div className="relative min-w-44 flex-1">
          <Search className="text-muted-foreground absolute top-2 left-2 h-3.5 w-3.5" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void search();
              }
            }}
            className="h-8 pl-7 text-xs"
            placeholder={t('traffic.search-body')}
          />
        </div>
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                aria-label={t('traffic.copy-loaded')}
                onClick={() => void copyLoaded()}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Clipboard className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('traffic.copy-loaded')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {previewOnly && (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => {
              setMode('full');
              setViewAll(true);
              void loadUntil(INITIAL_BYTES);
            }}
          >
            {t('traffic.view-all-body')}
          </Button>
        )}
        {viewAll && !complete && (
          <Button size="sm" variant="outline" className="h-8" onClick={() => void loadMore()}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {t(loadedBytes >= MAX_VIEW_BYTES ? 'traffic.load-next-window' : 'traffic.load-more')}
          </Button>
        )}
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                aria-label={t('traffic.save-full')}
                onClick={() =>
                  void window.electron.saveTrafficAuditBody(
                    body.id,
                    `traffic-${body.ownerKind}-${body.direction}-${body.id}.${body.kind === 'json' ? 'json' : 'txt'}`,
                  )
                }
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('traffic.save-full')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {searchResult && (
        <div className="bg-muted/20 max-h-28 overflow-auto border-b px-3 py-2 text-xs">
          <div className="text-muted-foreground mb-1">
            {t('traffic.matches', { count: searchResult.matches.length })}
            {searchResult.truncated ? ` (${t('traffic.first-100')})` : ''}
          </div>
          {searchResult.matches.slice(0, 20).map((match) => (
            <button
              key={`${match.offset}-${match.sequence}`}
              type="button"
              className="hover:bg-muted block w-full cursor-default truncate rounded px-1 py-0.5 text-left font-mono"
              onClick={() => void jumpToMatch(match)}
            >
              @{match.offset}: {match.snippet}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CodeMirror
          value={displayContent}
          height="100%"
          extensions={extensions}
          editable={false}
          onCreateEditor={(view) => {
            editor.current = view;
          }}
          basicSetup={{
            bracketMatching: true,
            foldGutter: true,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            lineNumbers: true,
          }}
        />
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-[11px]">
        <span>{body.representation}</span>
        <span>{body.state}</span>
        <span>
          {formatBytes(previewOnly ? Math.min(loadedBytes, PREVIEW_BYTES) : loadedBytes)} /{' '}
          {formatBytes(body.logicalBytes)}
        </span>
        {body.parseErrorOffset !== null && (
          <span className="text-destructive">
            {t('traffic.parse-error', { offset: body.parseErrorOffset })}
          </span>
        )}
        {body.partial && (
          <span className="text-amber-600 dark:text-amber-400">{t('traffic.partial')}</span>
        )}
        {body.droppedReason && <span>{body.droppedReason}</span>}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function utf8Prefix(value: string, byteLimit: number): string {
  let bytes = 0;
  let prefix = '';
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (bytes + characterBytes > byteLimit) {
      break;
    }
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}
