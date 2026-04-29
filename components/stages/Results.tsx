'use client';

import { useEffect, useState } from 'react';
import JSZip from 'jszip';
import { useJobStore } from '@/lib/store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type PhotoStatus = 'queued' | 'processing' | 'matched' | 'unmatched' | 'error' | 'skipped';

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

function StatusBadge({ status }: { status: PhotoStatus }) {
  const map: Record<PhotoStatus, { label: string; className: string }> = {
    queued:     { label: 'Queued',     className: 'bg-muted text-muted-foreground' },
    processing: { label: 'Processing', className: 'bg-blue-100 text-blue-700' },
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
    both:   { label: 'Face + Jersey', className: 'bg-green-100 text-green-700' },
    face:   { label: 'Face',          className: 'bg-blue-100 text-blue-700' },
    jersey: { label: 'Jersey',        className: 'bg-amber-100 text-amber-700' },
  };
  const cfg = map[matchType] ?? { label: matchType, className: 'bg-muted text-muted-foreground' };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

function bestConfidence(row: PhotoRow): number {
  return Math.max(row.faceConfidence ?? 0, row.jerseyConfidence ?? 0);
}

export function Results() {
  const { sessionId, jobName, batchNumber, recognitionEngine, reset } = useJobStore();

  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ done: number; total: number } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/photos/results?session_id=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setPhotos(data.photos ?? []);
      })
      .catch((err) => setFetchError(err instanceof Error ? err.message : 'Failed to load results'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  async function handleDownload() {
    if (!sessionId) return;
    setDownloading(true);
    setDownloadError(null);
    setDownloadProgress(null);

    try {
      // 1. Get signed URLs for all processed files
      const urlsResp = await fetch(`/api/download-urls?session_id=${encodeURIComponent(sessionId)}`);
      if (!urlsResp.ok) {
        const data = await urlsResp.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Failed to get download URLs (${urlsResp.status})`);
      }
      const { files } = await urlsResp.json() as { files: { filename: string; url: string }[] };

      // 2. Download each file and add to ZIP, updating progress as we go
      const zip = new JSZip();
      setDownloadProgress({ done: 0, total: files.length });

      for (let i = 0; i < files.length; i++) {
        const { filename, url } = files[i];
        const fileResp = await fetch(url);
        if (!fileResp.ok) throw new Error(`Failed to fetch ${filename}`);
        const buffer = await fileResp.arrayBuffer();
        zip.file(filename, buffer);
        setDownloadProgress({ done: i + 1, total: files.length });
      }

      // 3. Generate ZIP in browser
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const blobUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${jobName || 'photos'}.zip`;
      a.click();
      URL.revokeObjectURL(blobUrl);

      // 4. Clean up storage after successful download
      await fetch(`/api/download?session_id=${encodeURIComponent(sessionId)}&recognition_engine=${recognitionEngine}`, { method: 'DELETE' });
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
    }
  }

  // Derived summary stats from fetched photo rows
  const total = photos.length;
  const matched = photos.filter((p) => p.status === 'matched').length;
  const unmatched = photos.filter((p) => p.status === 'unmatched' || p.status === 'error' || p.status === 'skipped').length;
  const matchedPhotos = photos.filter((p) => p.status === 'matched');
  const avgConfidence =
    matchedPhotos.length > 0
      ? Math.round(
          (matchedPhotos.reduce((sum, p) => sum + bestConfidence(p), 0) / matchedPhotos.length) * 100
        )
      : null;

  const needsManual = photos.filter((p) =>
    p.status === 'unmatched' || p.status === 'skipped' || p.status === 'error'
  );

  return (
    <main className="min-h-screen flex flex-col items-center justify-start py-12 px-4">
      <div className="w-full max-w-5xl space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground uppercase tracking-wide">Job complete</p>
            <h1 className="text-2xl font-semibold">{jobName || 'Results'}</h1>
          </div>
          <Button variant="outline" onClick={() => reset()}>
            New Job
          </Button>
        </div>

        {/* Summary card */}
        {!loading && !fetchError && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Total processed</p>
                  <p className="text-2xl font-semibold">{total}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Matched</p>
                  <p className="text-2xl font-semibold text-green-600">
                    {matched}
                    <span className="text-sm font-normal text-muted-foreground ml-1">
                      {total > 0 ? `(${Math.round((matched / total) * 100)}%)` : ''}
                    </span>
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Unmatched</p>
                  <p className="text-2xl font-semibold text-yellow-600">
                    {unmatched}
                    <span className="text-sm font-normal text-muted-foreground ml-1">
                      {total > 0 ? `(${Math.round((unmatched / total) * 100)}%)` : ''}
                    </span>
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Avg confidence</p>
                  <p className="text-2xl font-semibold">
                    {avgConfidence !== null ? `${avgConfidence}%` : '—'}
                  </p>
                </div>
              </div>
              {batchNumber > 1 && (
                <p className="text-xs text-muted-foreground mt-3">
                  Processed in {batchNumber} batches
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Loading / error states */}
        {loading && (
          <div className="rounded-lg border bg-card px-6 py-8 text-center text-sm text-muted-foreground">
            Loading results…
          </div>
        )}
        {fetchError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-6 py-4 text-sm text-red-700">
            Failed to load results: {fetchError}
          </div>
        )}

        {/* Download / New Job actions */}
        {!loading && !fetchError && (
          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
              <Button onClick={handleDownload} disabled={downloading}>
                {downloading ? 'Preparing ZIP…' : 'Download All'}
              </Button>
              {downloadError && (
                <div className="flex items-center gap-2 text-sm text-red-600">
                  <span>{downloadError}</span>
                  <Button variant="outline" size="sm" onClick={handleDownload} disabled={downloading}>
                    Retry
                  </Button>
                </div>
              )}
            </div>
            {downloading && downloadProgress && (
              <div className="space-y-1 max-w-xs">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Downloading files…</span>
                  <span>{downloadProgress.done} / {downloadProgress.total}</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-150"
                    style={{ width: `${Math.round((downloadProgress.done / downloadProgress.total) * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Full photo table */}
        {!loading && photos.length > 0 && (
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
                {photos.map((row) => {
                  const conf = bestConfidence(row);
                  return (
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
                            —
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
                        {conf > 0 ? `${Math.round(conf * 100)}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Unmatched / skipped section */}
        {!loading && needsManual.length > 0 && (
          <div className="rounded-lg border bg-yellow-50 border-yellow-200 px-6 py-4 space-y-2">
            <p className="text-sm font-medium text-yellow-800">
              These files need manual captions in Photo Mechanic
            </p>
            <ul className="space-y-1">
              {needsManual.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-xs text-yellow-700">
                  <span className="font-mono">{p.filename}</span>
                  <StatusBadge status={p.status} />
                </li>
              ))}
            </ul>
          </div>
        )}

      </div>
    </main>
  );
}
