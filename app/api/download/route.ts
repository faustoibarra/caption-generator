import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const maxDuration = 60;

// Called by the client after the ZIP has been successfully generated and downloaded.
// Cleans up all session files from storage and the DB.
export async function DELETE(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session_id');
  if (!sessionId) {
    return NextResponse.json({ error: 'Missing session_id' }, { status: 400 });
  }

  const supabase = createServiceClient();

  try {
    const processedPrefix = `photos-processed/${sessionId}`;
    const { data: processedFiles } = await supabase.storage.from('photos-processed').list(processedPrefix);
    if (processedFiles && processedFiles.length > 0) {
      await supabase.storage.from('photos-processed').remove(
        processedFiles.map((f: { name: string }) => `${processedPrefix}/${f.name}`)
      );
    }

    const originalPrefix = `photos-original/${sessionId}`;
    const { data: originalFiles } = await supabase.storage.from('photos-original').list(originalPrefix);
    if (originalFiles && originalFiles.length > 0) {
      await supabase.storage.from('photos-original').remove(
        originalFiles.map((f: { name: string }) => `${originalPrefix}/${f.name}`)
      );
    }

    const { data: rosterFiles } = await supabase.storage.from('rosters').list(sessionId);
    if (rosterFiles && rosterFiles.length > 0) {
      await supabase.storage.from('rosters').remove(
        rosterFiles.map((f: { name: string }) => `${sessionId}/${f.name}`)
      );
    }

    await supabase.from('photos').delete().eq('session_id', sessionId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[cleanup] failed:', err);
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 });
  }
}
