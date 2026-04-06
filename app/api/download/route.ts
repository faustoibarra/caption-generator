import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { createServiceClient } from '@/lib/supabase/server';

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('session_id');
  const jobName = searchParams.get('job_name') ?? 'photos';

  if (!sessionId) {
    return NextResponse.json({ error: 'Missing session_id' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // List all files in photos-processed/{session_id}/ within the photos-processed bucket
  const processedPrefix = `photos-processed/${sessionId}`;
  const { data: files, error: listError } = await supabase.storage
    .from('photos-processed')
    .list(processedPrefix);

  if (listError) {
    return NextResponse.json({ error: `Failed to list files: ${listError.message}` }, { status: 500 });
  }

  if (!files || files.length === 0) {
    return NextResponse.json({ error: 'No processed files found for this session' }, { status: 404 });
  }

  // Download all files and add to ZIP
  const zip = new JSZip();
  try {
    await Promise.all(
      files.map(async (file: { name: string }) => {
        const filePath = `${processedPrefix}/${file.name}`;
        const { data: blob, error: downloadError } = await supabase.storage
          .from('photos-processed')
          .download(filePath);

        if (downloadError || !blob) {
          throw new Error(`Failed to download ${file.name}: ${downloadError?.message ?? 'unknown error'}`);
        }

        const buffer = await blob.arrayBuffer();
        zip.file(file.name, buffer);
      })
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to build ZIP' },
      { status: 500 }
    );
  }

  // Generate ZIP — if this fails, do NOT run cleanup
  let zipBlob: Blob;
  try {
    const zipArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
    zipBlob = new Blob([zipArrayBuffer], { type: 'application/zip' });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate ZIP' },
      { status: 500 }
    );
  }

  // ZIP generated successfully — run cleanup (errors logged but not surfaced)
  try {
    // photos-processed bucket: remove all session files
    const processedPaths = files.map((f: { name: string }) => `${processedPrefix}/${f.name}`);
    await supabase.storage.from('photos-processed').remove(processedPaths);

    // photos-original bucket: list and remove session files
    const originalPrefix = `photos-original/${sessionId}`;
    const { data: originalFiles } = await supabase.storage
      .from('photos-original')
      .list(originalPrefix);
    if (originalFiles && originalFiles.length > 0) {
      const originalPaths = originalFiles.map((f: { name: string }) => `${originalPrefix}/${f.name}`);
      await supabase.storage.from('photos-original').remove(originalPaths);
    }

    // rosters bucket: list and remove session headshots
    const { data: rosterFiles } = await supabase.storage
      .from('rosters')
      .list(sessionId);
    if (rosterFiles && rosterFiles.length > 0) {
      const rosterPaths = rosterFiles.map((f: { name: string }) => `${sessionId}/${f.name}`);
      await supabase.storage.from('rosters').remove(rosterPaths);
    }

    // DB cleanup
    await supabase.from('roster_athletes').delete().eq('session_id', sessionId);
    await supabase.from('photos').delete().eq('session_id', sessionId);
  } catch (cleanupErr) {
    console.error('[download] Cleanup failed (ZIP still returned):', cleanupErr);
  }

  const safeJobName = jobName.replace(/[^a-zA-Z0-9_\-. ]/g, '_');

  return new NextResponse(zipBlob, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeJobName}.zip"`,
    },
  });
}
