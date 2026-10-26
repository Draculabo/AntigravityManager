import { EditorView } from '@codemirror/view';
import { auditBodyExtensions, utf8Prefix } from './audit-body-editor';
import CodeMirror from '@uiw/react-codemirror';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleHelp, Download, Loader2, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/components/shared/theme-provider';
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
import { AuditBodyCaptureStatus, formatAuditBytes } from './AuditBodyCaptureStatus';
import { AuditBodyActions } from './AuditBodyActions';
import { AuditBodySearchResults } from './AuditBodySearchResults';

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
  const { theme } = useTheme();
  const isDarkTheme =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const active = useRef(true);
  const reading = useRef(false);
  const readSequence = useRef(0);
  const lastRead = useRef({ targetBytes: PREVIEW_BYTES, replaceWindow: false });
  const editor = useRef<EditorView | null>(null);
  const [content, setContent] = useState('');
  const [viewAll, setViewAll] = useState(false);
  const [cursor, setCursor] = useState<number | null>(0);
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [paused, setPaused] = useState(false);
  const [missing, setMissing] = useState(false);
  const [readSnapshot, setReadSnapshot] = useState({ source: body, value: body });
  const [mode, setMode] = useState<'concise' | 'full'>(() => {
    try {
      return localStorage.getItem('traffic-body-view-mode') === 'concise' ? 'concise' : 'full';
    } catch {
      return 'full';
    }
  });
  const [wrapLines, setWrapLines] = useState(true);
  const [modeUnsaved, setModeUnsaved] = useState(false);
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<TrafficAuditBodySearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [jumping, setJumping] = useState(false);
  const searchSequence = useRef(0);
  const jumpSequence = useRef(0);
  const [rawWindow, setRawWindow] = useState(false);
  const [jumpSelection, setJumpSelection] = useState<{ from: number; to: number } | null>(null);
  const loadedBytes = useMemo(() => new TextEncoder().encode(content).byteLength, [content]);
  const currentBody =
    body?.state === 'expired' || readSnapshot.source !== body ? body : readSnapshot.value;
  const previewOnly = !viewAll && currentBody !== null && currentBody.storedBytes > PREVIEW_BYTES;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      readSequence.current += 1;
      reading.current = false;
    };
  }, []);

  const loadUntil = useCallback(
    async (targetBytes: number, replaceWindow = false) => {
      if (
        !body ||
        reading.current ||
        complete ||
        cursor === null ||
        body.state === 'expired' ||
        missing
      ) {
        return;
      }
      reading.current = true;
      lastRead.current = { targetBytes, replaceWindow };
      const sequence = ++readSequence.current;
      setLoading(true);
      setLoadError(false);
      setPaused(false);
      let nextCursor: number | null = cursor;
      let loaded = replaceWindow ? '' : content;
      let received = false;
      let done: boolean = complete;
      try {
        let bytesInWindow = replaceWindow ? 0 : loadedBytes;
        while (
          !done &&
          nextCursor !== null &&
          bytesInWindow < Math.min(targetBytes, MAX_VIEW_BYTES) &&
          active.current &&
          sequence === readSequence.current
        ) {
          const page = await ipc.client.gateway.auditBodyPage({
            bodyId: body.id,
            cursor: nextCursor,
            limitBytes: Math.min(PAGE_BYTES, targetBytes),
          });
          if (!active.current || sequence !== readSequence.current) {
            return;
          }
          if (!page || page.body.state === 'expired') {
            setReadSnapshot({ source: body, value: page?.body ?? null });
            setMissing(!page);
            setContent('');
            setCursor(null);
            setComplete(true);
            return;
          }
          setReadSnapshot({ source: body, value: page.body });
          received = true;
          const segment = page.chunks.map((chunk) => chunk.data).join('');
          loaded += segment;
          bytesInWindow += new TextEncoder().encode(segment).byteLength;
          nextCursor = page.nextCursor;
          done = page.complete;
        }
        if (active.current && sequence === readSequence.current) {
          setContent(loaded);
          setRawWindow(false);
          setCursor(nextCursor);
          setComplete(done);
        }
      } catch {
        if (active.current && sequence === readSequence.current) {
          // Keep successful pages and their cursor; retry must not duplicate that prefix.
          if (received) {
            setContent(loaded);
            setCursor(nextCursor);
            setRawWindow(false);
            lastRead.current.replaceWindow = false;
          }
          setLoadError(true);
        }
      } finally {
        if (active.current && sequence === readSequence.current) {
          reading.current = false;
          setLoading(false);
        }
      }
    },
    [body, complete, content, cursor, loadedBytes, missing],
  );

  useEffect(() => {
    if (
      body &&
      body.state !== 'expired' &&
      content.length === 0 &&
      !loading &&
      !complete &&
      !loadError &&
      !missing &&
      !paused
    ) {
      queueMicrotask(() => loadUntil(viewAll ? INITIAL_BYTES : PREVIEW_BYTES));
    }
  }, [body, complete, content.length, loadUntil, loading, viewAll, loadError, missing, paused]);

  const displayContent = useMemo(() => {
    if (previewOnly && content) {
      return `${utf8Prefix(content, PREVIEW_BYTES)}…`;
    }
    return rawWindow ? content : formatAuditBody(content, currentBody?.kind ?? 'text', mode);
  }, [currentBody?.kind, content, mode, previewOnly, rawWindow]);
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
  const extensions = useMemo(
    () => auditBodyExtensions(currentBody, previewOnly, wrapLines),
    [currentBody, previewOnly, wrapLines],
  );

  if (!body || missing || currentBody?.state === 'expired') {
    return <AuditBodyCaptureStatus body={missing ? null : currentBody} />;
  }

  const loadMore = async () => {
    await loadUntil(MAX_VIEW_BYTES, loadedBytes >= MAX_VIEW_BYTES);
  };

  const jumpToMatch = async (match: TrafficAuditBodySearchResult['matches'][number]) => {
    if (reading.current) {
      return false;
    }
    reading.current = true;
    const sequence = jumpSequence.current + 1;
    jumpSequence.current = sequence;
    setJumping(true);
    try {
      const page = await ipc.client.gateway.auditBodyPage({
        bodyId: body.id,
        cursor: match.sequence,
        limitBytes: PAGE_BYTES,
      });
      if (!page || !active.current || sequence !== jumpSequence.current) {
        if (!page && active.current && sequence === jumpSequence.current) {
          setMissing(true);
          setContent('');
        }
        return false;
      }
      setReadSnapshot({ source: body, value: page.body });
      if (page.body.state === 'expired') {
        setContent('');
        return false;
      }
      setMode('full');
      setViewAll(true);
      setPaused(false);
      setLoadError(false);
      setContent(page.chunks.map((chunk) => chunk.data).join(''));
      setRawWindow(true);
      setCursor(page.nextCursor);
      setComplete(page.complete);
      setJumpSelection({ from: match.chunkOffset, to: match.chunkOffset + match.length });
      return true;
    } catch {
      if (active.current && sequence === jumpSequence.current) {
        setSearchError(true);
      }
      return false;
    } finally {
      if (active.current && sequence === jumpSequence.current) {
        reading.current = false;
        setJumping(false);
      }
    }
  };

  const search = async () => {
    const sequence = searchSequence.current + 1;
    searchSequence.current = sequence;
    if (!query.trim()) {
      setSearchResult(null);
      setSearchError(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    setSearchResult(null);
    setSearchError(false);
    try {
      const result = await ipc.client.gateway.auditBodySearch({
        bodyId: body.id,
        limit: 100,
        query: query.trim(),
      });
      if (active.current && sequence === searchSequence.current) {
        setSearchResult(result);
      }
    } catch {
      if (active.current && sequence === searchSequence.current) {
        setSearchResult(null);
        setSearchError(true);
      }
    } finally {
      if (active.current && sequence === searchSequence.current) {
        setSearching(false);
      }
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border">
      <AuditBodyCaptureStatus body={currentBody} />
      <div className="bg-muted/30 flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="bg-muted flex rounded-md p-0.5">
          {(['concise', 'full'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`rounded px-2.5 py-1 text-xs font-medium ${mode === value ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
              onClick={() => {
                setMode(value);
                try {
                  localStorage.setItem('traffic-body-view-mode', value);
                  setModeUnsaved(false);
                } catch {
                  setModeUnsaved(true);
                }
              }}
            >
              {value === 'concise' ? t('traffic.concise') : t('traffic.full')}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={wrapLines}
          onClick={() => setWrapLines((value) => !value)}
        >
          {t('traffic.wrap-lines')}
        </Button>
        {modeUnsaved && (
          <span role="status" className="text-muted-foreground text-xs">
            {t('traffic.view-mode-unsaved')}
          </span>
        )}
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
            aria-busy={searching}
            maxLength={512}
            className="h-8 pl-7 text-xs"
            placeholder={t('traffic.search-body')}
          />
          {searching && (
            <Loader2
              className="text-muted-foreground absolute top-2 right-2 h-3.5 w-3.5 animate-spin"
              aria-label={t('traffic.searching')}
            />
          )}
        </div>
        {searching && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              searchSequence.current += 1;
              setSearching(false);
            }}
          >
            {t('traffic.cancel-search')}
          </Button>
        )}
        {searchError && (
          <span role="alert" className="text-destructive text-xs">
            {t('traffic.search-failed')}
          </span>
        )}
        {jumping && (
          <span className="text-muted-foreground text-xs" role="status">
            {t('traffic.jumping')}
          </span>
        )}
        <AuditBodyActions
          body={currentBody ?? body}
          content={displayContent}
          disabled={loading || jumping || (body.storedBytes === 0 && body.kind !== 'empty')}
        />
        {currentBody?.state === 'writing' && (
          <Button
            size="sm"
            variant="outline"
            disabled={loading || jumping}
            onClick={() => {
              setContent('');
              setCursor(0);
              setComplete(false);
              setLoadError(false);
              setPaused(false);
            }}
          >
            {t('traffic.capture.refresh')}
          </Button>
        )}
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
      </div>
      {(loadError || paused) && (
        <div
          role={loadError ? 'alert' : 'status'}
          className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs"
        >
          <span className={loadError ? 'text-destructive' : 'text-muted-foreground'}>
            {t(loadError ? 'traffic.capture.read-failed' : 'traffic.capture.paused')}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() =>
              void loadUntil(lastRead.current.targetBytes, lastRead.current.replaceWindow)
            }
          >
            {t(paused ? 'traffic.capture.resume' : 'traffic.capture.retry')}
          </Button>
        </div>
      )}
      {loading && (
        <div
          role="status"
          className="text-muted-foreground flex shrink-0 items-center gap-2 px-3 py-2 text-xs"
        >
          {t('traffic.capture.loading')}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              readSequence.current += 1;
              reading.current = false;
              setLoading(false);
              setPaused(true);
            }}
          >
            {t('traffic.capture.cancel')}
          </Button>
        </div>
      )}
      {searchResult && <AuditBodySearchResults result={searchResult} onJump={jumpToMatch} />}
      <div className="min-h-0 flex-1">
        <CodeMirror
          value={displayContent}
          theme={isDarkTheme ? 'dark' : 'light'}
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
        <span>
          {t('traffic.capture.loaded', {
            size: formatAuditBytes(
              previewOnly ? Math.min(loadedBytes, PREVIEW_BYTES) : loadedBytes,
            ),
          })}
        </span>
        {currentBody && currentBody.parseErrorOffset !== null && (
          <span className="text-destructive">
            {t('traffic.parse-error', { offset: currentBody.parseErrorOffset })}
          </span>
        )}
      </div>
    </div>
  );
}
