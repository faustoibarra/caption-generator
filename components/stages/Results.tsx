'use client';

import { useEffect, useState } from 'react';
import JSZip from 'jszip';
import { useJobStore } from '@/lib/store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';

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

  type FilenameFormat = 'original' | 'sequence' | 'uuid';
  const [showFilenameDialog, setShowFilenameDialog] = useState(false);
  const [filenameFormat, setFilenameFormat] = useState<FilenameFormat>('original');
  const [sequencePrefix, setSequencePrefix] = useState(jobName || 'IMG');
  const [appendConfidence, setAppendConfidence] = useState(false);

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

  async function handleDownload(format: FilenameFormat, prefix: string, withConfidence: boolean) {
    if (!sessionId) return;
    setShowFilenameDialog(false);
    setDownloading(true);
    setDownloadError(null);
    setDownloadProgress(null);

    try {
      const zip = new JSZip();

      if (withConfidence) {
        // Per-photo endpoint rewrites Personality with confidence % appended
        setDownloadProgress({ done: 0, total: photos.length });
        for (let i = 0; i < photos.length; i++) {
          const photo = photos[i];
          const ext = photo.filename.includes('.') ? photo.filename.slice(photo.filename.lastIndexOf('.')) : '.jpg';
          const zipName =
            format === 'sequence' ? `${prefix}_${String(i + 1).padStart(3, '0')}${ext}` :
            format === 'uuid'     ? `${crypto.randomUUID()}${ext}` :
            photo.filename;
          const fileResp = await fetch(`/api/photos/${photo.id}/download-file?append_confidence=true`);
          if (!fileResp.ok) throw new Error(`Failed to fetch ${photo.filename}`);
          const buffer = await fileResp.arrayBuffer();
          zip.file(zipName, buffer);
          setDownloadProgress({ done: i + 1, total: photos.length });
        }
      } else {
        // Standard flow: signed URLs from storage
        const urlsResp = await fetch(`/api/download-urls?session_id=${encodeURIComponent(sessionId)}`);
        if (!urlsResp.ok) {
          const data = await urlsResp.json().catch(() => ({}));
          throw new Error((data as { error?: string }).error ?? `Failed to get download URLs (${urlsResp.status})`);
        }
        const { files } = await urlsResp.json() as { files: { filename: string; url: string }[] };
        setDownloadProgress({ done: 0, total: files.length });

        for (let i = 0; i < files.length; i++) {
          const { filename, url } = files[i];
          const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '.jpg';
          const zipName =
            format === 'sequence' ? `${prefix}_${String(i + 1).padStart(3, '0')}${ext}` :
            format === 'uuid'     ? `${crypto.randomUUID()}${ext}` :
            filename;
          const fileResp = await fetch(url);
          if (!fileResp.ok) throw new Error(`Failed to fetch ${filename}`);
          const buffer = await fileResp.arrayBuffer();
          zip.file(zipName, buffer);
          setDownloadProgress({ done: i + 1, total: files.length });
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const blobUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${jobName || 'photos'}.zip`;
      a.click();
      URL.revokeObjectURL(blobUrl);

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

        {/* Filename format dialog */}
        {showFilenameDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowFilenameDialog(false)}>
            <div className="bg-background rounded-xl border shadow-lg w-full max-w-sm mx-4 p-6 space-y-5" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-base font-semibold">Choose filename format</h2>
              <div className="space-y-3">
                {([
                  { value: 'original', label: 'Original filenames', description: 'Keep the uploaded filenames as-is' },
                  { value: 'sequence', label: 'Prefix + sequence', description: 'e.g. IMG_001.jpg, IMG_002.jpg' },
                  { value: 'uuid',     label: 'UUID',              description: 'e.g. 550e8400-e29b…-446655440000.jpg' },
                ] as { value: FilenameFormat; label: string; description: string }[]).map(({ value, label, description }) => (
                  <label key={value} className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="filenameFormat"
                      value={value}
                      checked={filenameFormat === value}
                      onChange={() => setFilenameFormat(value)}
                      className="mt-0.5 accent-primary"
                    />
                    <div>
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-xs text-muted-foreground">{description}</p>
                    </div>
                  </label>
                ))}
              </div>
              {filenameFormat === 'sequence' && (
                <div className="space-y-1.5">
                  <Label htmlFor="seq-prefix">Prefix</Label>
                  <Input
                    id="seq-prefix"
                    value={sequencePrefix}
                    onChange={(e) => setSequencePrefix(e.target.value)}
                    placeholder="IMG"
                  />
                </div>
              )}
              <div className="border-t pt-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <Checkbox
                    id="appendConfidence"
                    checked={appendConfidence}
                    onCheckedChange={(checked) => setAppendConfidence(checked === true)}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm font-medium">Append confidence to Personality field</p>
                    <p className="text-xs text-muted-foreground">e.g. "Valerie Glozman (53%)" — matched photos only</p>
                  </div>
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" onClick={() => setShowFilenameDialog(false)}>Cancel</Button>
                <Button onClick={() => handleDownload(filenameFormat, sequencePrefix, appendConfidence)}>Download</Button>
              </div>
            </div>
          </div>
        )}

        {/* Download / New Job actions */}
        {!loading && !fetchError && (
          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
              <Button onClick={() => setShowFilenameDialog(true)} disabled={downloading}>
                {downloading ? 'Preparing ZIP…' : 'Download All'}
              </Button>
              {downloadError && (
                <div className="flex items-center gap-2 text-sm text-red-600">
                  <span>{downloadError}</span>
                  <Button variant="outline" size="sm" onClick={() => setShowFilenameDialog(true)} disabled={downloading}>
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
