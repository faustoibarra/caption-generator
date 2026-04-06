import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = createServiceClient();

  const { data: photo, error } = await supabase
    .from('photos')
    .select('id, status, matched_names, match_type, face_confidence, jersey_confidence, filename, processed_path, storage_path')
    .eq('id', id)
    .single();

  if (error || !photo) {
    return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
  }

  let thumbnailUrl: string | null = null;
  if (photo.storage_path) {
    const { data: thumb } = await supabase.storage
      .from('photos-original')
      .createSignedUrl(photo.storage_path, 3600);
    thumbnailUrl = thumb?.signedUrl ?? null;
  }

  return NextResponse.json({
    status: photo.status,
    matched_names: photo.matched_names ?? null,
    match_type: photo.match_type ?? null,
    face_confidence: photo.face_confidence ?? null,
    jersey_confidence: photo.jersey_confidence ?? null,
    filename: photo.filename,
    thumbnail_url: thumbnailUrl,
  });
}
