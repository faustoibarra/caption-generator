import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session_id');
  if (!sessionId) {
    return NextResponse.json({ error: 'Missing session_id' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const processedPrefix = `photos-processed/${sessionId}`;

  const { data: files, error } = await supabase.storage
    .from('photos-processed')
    .list(processedPrefix);

  if (error) {
    return NextResponse.json({ error: `Failed to list files: ${error.message}` }, { status: 500 });
  }

  if (!files || files.length === 0) {
    return NextResponse.json({ error: 'No processed files found' }, { status: 404 });
  }

  // Look up original filenames from the photos table keyed by processed_path
  const { data: photoRows } = await supabase
    .from('photos')
    .select('processed_path, filename')
    .eq('session_id', sessionId);

  const filenameByPath: Record<string, string> = {};
  for (const row of photoRows ?? []) {
    if (row.processed_path) filenameByPath[row.processed_path] = row.filename;
  }

  // Generate signed URLs for all files in parallel
  const fileList = await Promise.all(
    files.map(async (file: { name: string }) => {
      const filePath = `${processedPrefix}/${file.name}`;
      const { data: signed } = await supabase.storage
        .from('photos-processed')
        .createSignedUrl(filePath, 3600);
      const originalFilename = filenameByPath[filePath] ?? file.name;
      return { filename: originalFilename, url: signed?.signedUrl ?? null };
    })
  );

  return NextResponse.json({ files: fileList.filter((f) => f.url !== null) });
}
