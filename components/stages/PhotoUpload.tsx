'use client';

import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { CheckCircle, XCircle, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useJobStore } from '@/lib/store';

interface FileEntry {
  id: string;
  file: File;
  progress: number; // 0–100
  status: 'uploading' | 'done' | 'error';
  photoId?: string;
  thumbnailUrl?: string | null;
  errorMessage?: string;
}

async function uploadFile(
  file: File,
  sessionId: string,
  onProgress: (pct: number) => void
): Promise<string> {
  // Step 1: get a signed upload URL and photo_id from the server (tiny JSON request, no size limit)
  const urlRes = await fetch('/api/photos/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, filename: file.name }),
  });
  if (!urlRes.ok) {
    const data = await urlRes.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `Upload failed (${urlRes.status})`);
  }
  const { photo_id, signed_url, thumbnail_url } = await urlRes.json() as { photo_id: string; signed_url: string; thumbnail_url: string | null };

  // Step 2: PUT the file directly to Supabase Storage — bypasses Vercel's 4.5MB body limit
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signed_url);
    xhr.setRequestHeader('Content-Type', 'image/jpeg');

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Storage upload failed (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

    xhr.send(file);
  });

  return { photo_id, thumbnail_url };
}

export function PhotoUpload() {
  const { sessionId, addUploadedPhoto, setProcessing } = useJobStore();
  const [files, setFiles] = useState<FileEntry[]>([]);

  const startUpload = useCallback(
    (file: File, entryId: string) => {
      if (!sessionId) return;

      setFiles((prev) =>
        prev.map((f) =>
          f.id === entryId ? { ...f, status: 'uploading', progress: 0, errorMessage: undefined } : f
        )
      );

      uploadFile(
        file,
        sessionId,
        (pct) => {
          setFiles((prev) =>
            prev.map((f) => (f.id === entryId ? { ...f, progress: pct } : f))
          );
        }
      )
        .then(({ photo_id, thumbnail_url }) => {
          addUploadedPhoto(photo_id);
          setFiles((prev) =>
            prev.map((f) =>
              f.id === entryId ? { ...f, status: 'done', progress: 100, photoId: photo_id, thumbnailUrl: thumbnail_url } : f
            )
          );
        })
        .catch((err: Error) => {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === entryId ? { ...f, status: 'error', errorMessage: err.message } : f
            )
          );
        });
    },
    [sessionId, addUploadedPhoto]
  );

  const onDrop = useCallback(
    (accepted: File[]) => {
      const newEntries: FileEntry[] = accepted.map((file) => ({
        id: `${file.name}-${Date.now()}-${Math.random()}`,
        file,
        progress: 0,
        status: 'uploading',
      }));

      setFiles((prev) => [...prev, ...newEntries]);

      newEntries.forEach((entry) => {
        startUpload(entry.file, entry.id);
      });
    },
    [startUpload]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/jpeg': ['.jpg', '.JPG', '.jpeg', '.JPEG'] },
    multiple: true,
  });

  const successCount = files.filter((f) => f.status === 'done').length;
  const canStart = successCount > 0;

  async function handleStartProcessing() {
    const completedFiles = files.filter((f) => f.status === 'done' && f.photoId);
    const batchPhotoIds = completedFiles.map((f) => f.photoId!);
    const batchPhotoMeta = Object.fromEntries(
      completedFiles.map((f) => [f.photoId!, { filename: f.file.name, thumbnailUrl: f.thumbnailUrl ?? null }])
    );
    setProcessing(batchPhotoIds, batchPhotoMeta);
    await fetch('/api/photos/start-processing', { method: 'POST' });
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-start py-12 px-4">
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Photo Upload</h1>
          {successCount > 0 && (
            <span className="text-sm font-medium bg-muted px-3 py-1 rounded-full">
              {successCount} photo{successCount !== 1 ? 's' : ''} uploaded
            </span>
          )}
        </div>

        {/* Drop zone */}
        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
            isDragActive
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30'
          }`}
        >
          <input {...getInputProps()} />
          <UploadCloud className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
          {isDragActive ? (
            <p className="text-sm font-medium">Drop JPGs here…</p>
          ) : (
            <>
              <p className="text-sm font-medium">Drag &amp; drop JPGs here</p>
              <p className="text-xs text-muted-foreground mt-1">or click to browse</p>
            </>
          )}
        </div>

        {/* File list */}
        {files.length > 0 && (
          <ul className="space-y-3">
            {files.map((entry) => (
              <li key={entry.id} className="rounded-lg border bg-card px-4 py-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate flex-1">{entry.file.name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {entry.status === 'done' && (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    )}
                    {entry.status === 'error' && (
                      <>
                        <XCircle className="h-4 w-4 text-destructive" />
                        <button
                          onClick={() => startUpload(entry.file, entry.id)}
                          className="text-xs text-primary underline"
                        >
                          Retry
                        </button>
                      </>
                    )}
                    {entry.status === 'uploading' && (
                      <span className="text-xs text-muted-foreground">{entry.progress}%</span>
                    )}
                  </div>
                </div>

                {/* Progress bar */}
                {entry.status !== 'error' && (
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-150 ${
                        entry.status === 'done' ? 'bg-green-500' : 'bg-primary'
                      }`}
                      style={{ width: `${entry.progress}%` }}
                    />
                  </div>
                )}

                {entry.status === 'error' && entry.errorMessage && (
                  <p className="text-xs text-destructive">{entry.errorMessage}</p>
                )}
              </li>
            ))}
          </ul>
        )}

        <Button
          onClick={handleStartProcessing}
          disabled={!canStart}
          className="w-full"
          size="lg"
        >
          Start Processing
        </Button>
      </div>
    </main>
  );
}
