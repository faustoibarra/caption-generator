import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Failed to parse form data' }, { status: 400 });
  }

  const file = formData.get('file') as File | null;
  const sessionId = formData.get('session_id') as string | null;

  if (!file || !sessionId) {
    return NextResponse.json({ error: 'Missing file or session_id' }, { status: 400 });
  }

  if (file.type !== 'image/jpeg') {
    return NextResponse.json({ error: 'File must be image/jpeg' }, { status: 400 });
  }

  const filename = file.name;
  const storagePath = `photos-original/${sessionId}/${filename}`;

  const supabase = createServiceClient();

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { error: uploadError } = await supabase.storage
    .from('photos-original')
    .upload(storagePath, buffer, {
      contentType: 'image/jpeg',
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json({ error: `Storage upload failed: ${uploadError.message}` }, { status: 500 });
  }

  const { data: photo, error: dbError } = await supabase
    .from('photos')
    .insert({
      session_id: sessionId,
      filename,
      storage_path: storagePath,
      status: 'queued',
    })
    .select('id')
    .single();

  if (dbError) {
    return NextResponse.json({ error: `DB insert failed: ${dbError.message}` }, { status: 500 });
  }

  return NextResponse.json({ photo_id: photo.id });
}
