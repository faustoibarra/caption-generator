import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { writePersonalityOnly } from '@/lib/xmp-writer';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const appendConfidence = request.nextUrl.searchParams.get('append_confidence') === 'true';
  const threshold = parseFloat(request.nextUrl.searchParams.get('threshold') ?? '1');

  const supabase = createServiceClient();

  const { data: photo, error } = await supabase
    .from('photos')
    .select('id, filename, processed_path, status, matched_names, face_confidence, jersey_confidence, athlete_confidences')
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
    // Build per-athlete names: append "(X%)" only for athletes below threshold
    let personalityNames: string[];

    const perAthlete = photo.athlete_confidences as { name: string; confidence: number }[] | null;
    if (Array.isArray(perAthlete) && perAthlete.length > 0) {
      personalityNames = perAthlete.map(({ name, confidence }) =>
        confidence < threshold ? `${name} (${Math.round(confidence * 100)}%)` : name
      );
    } else {
      // Fallback for rows processed before per-athlete confidence was added
      const overallConfidence = Math.max(
        typeof photo.face_confidence === 'number' ? photo.face_confidence : 0,
        typeof photo.jersey_confidence === 'number' ? photo.jersey_confidence : 0
      );
      personalityNames = (photo.matched_names as string[]).map((name) =>
        overallConfidence < threshold ? `${name} (${Math.round(overallConfidence * 100)}%)` : name
      );
    }

    try {
      buffer = await writePersonalityOnly(buffer, personalityNames);
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
