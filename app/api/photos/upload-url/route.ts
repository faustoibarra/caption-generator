import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  let body: { session_id: string; filename: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { session_id, filename } = body;
  if (!session_id || !filename) {
    return NextResponse.json({ error: 'Missing session_id or filename' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const storagePath = `photos-original/${session_id}/${filename}`;

  // Create signed upload URL — client will PUT directly to Supabase (no size limit)
  const { data: signed, error: signErr } = await supabase.storage
    .from('photos-original')
    .createSignedUploadUrl(storagePath);

  if (signErr || !signed) {
    return NextResponse.json({ error: `Failed to create upload URL: ${signErr?.message}` }, { status: 500 });
  }

  // Insert DB record now so photo_id is ready before the upload completes
  const { data: photo, error: dbError } = await supabase
    .from('photos')
    .insert({ session_id, filename, storage_path: storagePath, status: 'queued' })
    .select('id')
    .single();

  if (dbError) {
    return NextResponse.json({ error: `DB insert failed: ${dbError.message}` }, { status: 500 });
  }

  return NextResponse.json({
    photo_id: photo.id,
    signed_url: signed.signedUrl,
    storage_path: storagePath,
  });
}
