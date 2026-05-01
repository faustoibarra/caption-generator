import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { writePersonalityOnly } from '@/lib/xmp-writer';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const appendConfidence = request.nextUrl.searchParams.get('append_confidence') === 'true';

  const supabase = createServiceClient();

  const { data: photo, error } = await supabase
    .from('photos')
    .select('id, filename, processed_path, status, matched_names, face_confidence, jersey_confidence')
    .eq('id', id)
    .single();

  if (error || !photo || !photo.processed_path) {
    return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
  }

  const { data: blob, error: storageErr } = await supabase.storage
    .from('photos-processed')
    .download(photo.processed_path);

  if (storageErr || !blob) {
    return NextResponse.json({ error: 'File not found in storage' }, { status: 404 });
  }

  let buffer = Buffer.from(await blob.arrayBuffer());

  if (
    appendConfidence &&
    photo.status === 'matched' &&
    Array.isArray(photo.matched_names) &&
    photo.matched_names.length > 0
  ) {
    const confidence = Math.max(
      typeof photo.face_confidence === 'number' ? photo.face_confidence : 0,
      typeof photo.jersey_confidence === 'number' ? photo.jersey_confidence : 0
    );
    const namesWithConfidence = (photo.matched_names as string[]).map(
      (name) => `${name} (${Math.round(confidence * 100)}%)`
    );
    try {
      buffer = await writePersonalityOnly(buffer, namesWithConfidence);
    } catch {
      // XMP rewrite failed — return unmodified buffer
    }
  }

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Disposition': `attachment; filename="${photo.filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
