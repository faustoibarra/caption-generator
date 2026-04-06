import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('session_id');

  if (!sessionId) {
    return NextResponse.json({ error: 'Missing session_id' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: photos, error } = await supabase
    .from('photos')
    .select('id, filename, status, storage_path, matched_names, face_confidence, jersey_confidence, match_type')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!photos || photos.length === 0) {
    return NextResponse.json({ photos: [] });
  }

  // Generate signed thumbnail URLs for all photos in parallel
  interface PhotoRecord {
    id: string;
    filename: string;
    status: string;
    storage_path: string;
    matched_names: string[] | null;
    face_confidence: number | null;
    jersey_confidence: number | null;
    match_type: string | null;
  }

  const rows = await Promise.all(
    (photos as PhotoRecord[]).map(async (p) => {
      const { data: signed } = await supabase.storage
        .from('photos-original')
        .createSignedUrl(p.storage_path, 3600);

      return {
        id: p.id,
        filename: p.filename,
        status: p.status,
        matchedNames: p.matched_names ?? null,
        matchType: p.match_type ?? null,
        faceConfidence: p.face_confidence ?? null,
        jerseyConfidence: p.jersey_confidence ?? null,
        thumbnailUrl: signed?.signedUrl ?? null,
      };
    })
  );

  return NextResponse.json({ photos: rows });
}
