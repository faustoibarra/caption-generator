import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { deleteCollection } from '@/lib/rekognition';

export const maxDuration = 60;

// Called by the client after the ZIP has been successfully generated and downloaded.
// Cleans up all session files from storage and the DB.
export async function DELETE(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session_id');
  const recognitionEngine = request.nextUrl.searchParams.get('recognition_engine');
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

    // Roster headshot files in the 'rosters' bucket are NOT deleted here.
    // roster_athletes rows persist so the roster can be reused across jobs;
    // deleting the files would cause check-roster to return null headshot URLs.

    await supabase.from('photos').delete().eq('session_id', sessionId);

    if (recognitionEngine === 'rekognition') {
      await deleteCollection(sessionId);
      console.log(`[cleanup] Deleted Rekognition collection  session=${sessionId}`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[cleanup] failed:', err);
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 });
  }
}
