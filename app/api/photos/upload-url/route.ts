import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { randomUUID } from 'crypto';

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

  // Always generate a fresh UUID-based storage path — never use the original filename.
  // This avoids invalid-key errors from filenames with spaces, colons, or other special chars.
  // On retry, the DB record's storage_path is updated to the new UUID path.
  const storagePath = `photos-original/${session_id}/${randomUUID()}.jpg`;

  // Check for an existing record so retries reuse the same photo_id (no duplicate rows).
  const { data: existing } = await supabase
    .from('photos')
    .select('id')
    .eq('session_id', session_id)
    .eq('filename', filename)
    .single();

  // Create signed upload URL — upsert:true so retries don't fail if file already exists
  const { data: signed, error: signErr } = await supabase.storage
    .from('photos-original')
    .createSignedUploadUrl(storagePath, { upsert: true });

  if (signErr || !signed) {
    return NextResponse.json({ error: `Failed to create upload URL: ${signErr?.message}` }, { status: 500 });
  }

  // Signed download URL for thumbnail display (valid 1h)
  const { data: thumb } = await supabase.storage
    .from('photos-original')
    .createSignedUrl(storagePath, 3600);
  const thumbnailUrl = thumb?.signedUrl ?? null;

  if (existing) {
    await supabase.from('photos').update({ status: 'queued', error_message: null, storage_path: storagePath }).eq('id', existing.id);
    return NextResponse.json({ photo_id: existing.id, signed_url: signed.signedUrl, thumbnail_url: thumbnailUrl });
  }

  // First upload — insert new record
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
    thumbnail_url: thumbnailUrl,
  });
}
