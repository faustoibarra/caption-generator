import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const session_id = searchParams.get('session_id');

  if (!session_id) {
    return NextResponse.json({ error: 'Missing session_id' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: photos, error } = await supabase
    .from('photos')
    .select('id, status')
    .eq('session_id', session_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  interface PhotoRow { id: string; status: string; }
  const rows: PhotoRow[] = photos ?? [];
  const terminal = new Set(['matched', 'unmatched', 'error', 'skipped']);

  const photos_total = rows.length;
  const photos_matched = rows.filter((r) => r.status === 'matched').length;
  const photos_unmatched = rows.filter((r) => r.status === 'unmatched' || r.status === 'error' || r.status === 'skipped').length;
  const photos_processed = rows.filter((r) => terminal.has(r.status)).length;
  const photo_ids = rows.map((r) => r.id);

  return NextResponse.json({
    photos_total,
    photos_processed,
    photos_matched,
    photos_unmatched,
    photo_ids,
  });
}
