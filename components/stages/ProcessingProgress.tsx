'use client';

import { useEffect, useRef, useState } from 'react';
import { useJobStore } from '@/lib/store';
import { Button } from '@/components/ui/button';

const PROCESSING_CONCURRENCY = 3;

type PhotoStatus = 'queued' | 'processing' | 'matched' | 'unmatched' | 'error' | 'skipped';

const TERMINAL: Set<PhotoStatus> = new Set(['matched', 'unmatched', 'error', 'skipped']);

interface PhotoRow {
  id: string;
  filename: string;
  status: PhotoStatus;
  matchedNames: string[] | null;
  matchType: string | null;
  faceConfidence: number | null;
  jerseyConfidence: number | null;
  thumbnailUrl: string | null;
}

interface SessionStats {
  photos_total: number;
  photos_processed: number;
  photos_matched: number;
  photos_unmatched: number;
}

function StatusBadge({ status }: { status: PhotoStatus }) {
  const map: Record<PhotoStatus, { label: string; className: string }> = {
    queued:     { label: 'Queued',     className: 'bg-muted text-muted-foreground' },
    processing: { label: 'Processing', className: 'bg-blue-100 text-blue-700 animate-pulse' },
    matched:    { label: 'Matched',    className: 'bg-green-100 text-green-700' },
    unmatched:  { label: 'Unmatched',  className: 'bg-yellow-100 text-yellow-700' },
    error:      { label: 'Error',      className: 'bg-red-100 text-red-700' },
    skipped:    { label: 'Skipped',    className: 'bg-muted text-muted-foreground' },
  };
  const { label, className } = map[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

function MatchTypeBadge({ matchType }: { matchType: string | null }) {
  if (!matchType) {
    return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">—</span>;
  }
  const map: Record<string, { label: string; className: string }> = {
    both:    { label: 'Face + Jersey', className: 'bg-green-100 text-green-700' },
    face:    { label: 'Face',          className: 'bg-blue-100 text-blue-700' },
    jersey:  { label: 'Jersey',        className: 'bg-amber-100 text-amber-700' },
  };
  const cfg = map[matchType] ?? { label: matchType, className: 'bg-muted text-muted-foreground' };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

function confidence(row: PhotoRow): string | null {
  const best = Math.max(row.faceConfidence ?? 0, row.jerseyConfidence ?? 0);
  return best > 0 ? `${Math.round(best * 100)}%` : null;
}

export function ProcessingProgress() {
  const {
    currentBatchPhotoIds,
    currentBatchPhotoMeta,
    batchNumber,
    cumulativeStats,
    sessionId,
    confidenceThreshold,
    hasJerseyNumbers,
    sport,
    finishBatch,
    finishJob,
    startNextBatch,
  } = useJobStore();

  // Build initial rows from batch meta
  const makeInitialRows = (): Record<string, PhotoRow> =>
    Object.fromEntries(
      currentBatchPhotoIds.map((id) => [
        id,
        {
          id,
          filename: currentBatchPhotoMeta[id]?.filename ?? id,
          status: 'queued' as PhotoStatus,
          matchedNames: null,
          matchType: null,
          faceConfidence: null,
          jerseyConfidence: null,
          thumbnailUrl: null,
        },
      ])
    );

  const [photoRows, setPhotoRows] = useState<Record<string, PhotoRow>>(makeInitialRows);
  const [batchComplete, setBatchComplete] = useState(false);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);

  // Refs to avoid stale closures in the async queue
  const photoRowsRef = useRef<Record<string, PhotoRow>>(makeInitialRows());
  const queueRef = useRef<string[]>([...currentBatchPhotoIds]);
  const inFlightRef = useRef(0);
  const batchCompleteRef = useRef(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Update ref immediately (synchronous) so checkComplete() always sees latest state,
  // then sync to React state for rendering.
  function updateRow(id: string, updates: Partial<PhotoRow>) {
    photoRowsRef.current = {
      ...photoRowsRef.current,
      [id]: { ...photoRowsRef.current[id], ...updates },
    };
    setPhotoRows({ ...photoRowsRef.current });
  }

  useEffect(() => {
    // Start polling
    pollingRef.current = setInterval(() => {
      if (!sessionId) return;
      fetch(`/api/status?session_id=${sessionId}`)
        .then((r) => r.json())
        .then((data: SessionStats) => setSessionStats(data))
        .catch(() => {});
    }, 2000);

    function checkComplete() {
      if (batchCompleteRef.current) return;
      if (inFlightRef.current > 0 || queueRef.current.length > 0) return;

      const allDone = currentBatchPhotoIds.every((id) => {
        const row = photoRowsRef.current[id];
        return row && TERMINAL.has(row.status);
      });

      if (!allDone) return;

      batchCompleteRef.current = true;
      setBatchComplete(true);

      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }

      // Final status poll for session-wide totals
      if (sessionId) {
        fetch(`/api/status?session_id=${sessionId}`)
          .then((r) => r.json())
          .then((data: SessionStats) => {
            setSessionStats(data);
            finishBatch({ total: data.photos_total, matched: data.photos_matched, unmatched: data.photos_unmatched });
          })
          .catch(() => {});
      }
    }

    async function processPhoto(id: string) {
      updateRow(id, { status: 'processing' });
      try {
        const resp = await fetch(`/api/photos/${id}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confidence_threshold: confidenceThreshold,
            has_jersey_numbers: hasJerseyNumbers,
            sport,
          }),
        });
        const data = await resp.json();
        updateRow(id, {
          status: (data.status as PhotoStatus) ?? 'error',
          matchedNames: data.matched_names ?? null,
          matchType: data.match_type ?? null,
          faceConfidence: data.face_confidence ?? null,
          jerseyConfidence: data.jersey_confidence ?? null,
          thumbnailUrl: data.thumbnail_url ?? null,
          ...(data.filename ? { filename: data.filename } : {}),
        });
      } catch {
        updateRow(id, { status: 'error' });
      }
    }

    function drain() {
      while (inFlightRef.current < PROCESSING_CONCURRENCY && queueRef.current.length > 0) {
        const id = queueRef.current.shift()!;
        inFlightRef.current++;
        processPhoto(id).finally(() => {
          inFlightRef.current--;
          drain();
          checkComplete();
        });
      }
      if (queueRef.current.length === 0 && inFlightRef.current === 0) {
        checkComplete();
      }
    }

    drain();

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Batch-scoped counts from local state
  const rows = currentBatchPhotoIds.map((id) => photoRows[id]).filter(Boolean);
  const batchMatched = rows.filter((r) => r.status === 'matched').length;
  const batchUnmatched = rows.filter((r) => r.status === 'unmatched' || r.status === 'error' || r.status === 'skipped').length;
  const batchInProgress = rows.filter((r) => r.status === 'processing' || r.status === 'queued').length;

  return (
    <main className="min-h-screen flex flex-col items-center justify-start py-12 px-4">
      <div className="w-full max-w-5xl space-y-6">

        {/* Summary bar */}
        <div className="rounded-lg border bg-card px-6 py-4 space-y-1">
          <div className="flex flex-wrap items-center gap-4 text-sm font-medium">
            <span className="text-muted-foreground">Batch {batchNumber}</span>
            <span>Total: {rows.length}</span>
            <span className="text-green-600">Matched: {batchMatched}</span>
            <span className="text-yellow-600">Unmatched: {batchUnmatched}</span>
            {!batchComplete && (
              <span className="text-blue-600">In Progress: {batchInProgress}</span>
            )}
          </div>
          {batchNumber > 1 && cumulativeStats && (
            <p className="text-xs text-muted-foreground">
              Job total: {cumulativeStats.matched} matched, {cumulativeStats.unmatched} unmatched across {cumulativeStats.batches} batch{cumulativeStats.batches !== 1 ? 'es' : ''}
            </p>
          )}
        </div>

        {/* Photo table */}
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground w-[140px]">Thumbnail</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Filename</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground w-[110px]">Status</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Athlete(s)</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground w-[120px]">Match Type</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground w-[90px]">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.id} className="bg-card hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2">
                    {row.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={row.thumbnailUrl}
                        alt={row.filename}
                        width={120}
                        height={80}
                        className="rounded object-cover w-[120px] h-[80px]"
                      />
                    ) : (
                      <div className="w-[120px] h-[80px] rounded bg-muted flex items-center justify-center text-muted-foreground text-xs">
                        {row.status === 'processing' ? '…' : '—'}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs truncate max-w-[200px]">{row.filename}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {row.matchedNames?.join(', ') ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <MatchTypeBadge matchType={row.matchType} />
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {confidence(row) ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Batch Complete action bar */}
        {batchComplete && (
          <div className="sticky bottom-6 rounded-lg border bg-card shadow-lg px-6 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="font-semibold">
                Batch {batchNumber} complete — {batchMatched} matched, {batchUnmatched} unmatched
              </p>
              {sessionStats && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Session total: {sessionStats.photos_matched} matched, {sessionStats.photos_unmatched} unmatched
                </p>
              )}
            </div>
            <div className="flex gap-3 shrink-0">
              <Button variant="outline" onClick={() => startNextBatch()}>
                Upload More Photos
              </Button>
              <Button onClick={() => finishJob()}>
                Finish &amp; Download ZIP
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
