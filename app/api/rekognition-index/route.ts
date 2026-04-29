import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { createCollection, indexFace } from '@/lib/rekognition';

export const maxDuration = 300;

// Indexes headshots from an already-scraped roster into a Rekognition collection.
// Used when the user chooses to reuse an existing roster in Rekognition mode.
export async function POST(req: NextRequest) {
  try {
    const { session_id } = await req.json();
    if (!session_id) {
      return NextResponse.json({ ok: false, error: 'Missing session_id' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: athletes, error } = await supabase
      .from('roster_athletes')
      .select('id, name, headshot_url')
      .eq('session_id', session_id)
      .not('headshot_url', 'is', null);

    if (error) throw new Error(error.message);

    const rows = athletes ?? [];
    console.log(`[rekognition-index] session=${session_id} athletes_with_headshots=${rows.length}`);

    await createCollection(session_id);

    const results = await Promise.allSettled(
      rows.map(async (athlete: { id: string; name: string; headshot_url: string | null }) => {
        const { data: blob } = await supabase.storage
          .from('rosters')
          .download(athlete.headshot_url!);
        if (!blob) {
          console.warn(`[rekognition-index] ${athlete.name}  download returned null`);
          return { indexed: false };
        }
        const buf = Buffer.from(await blob.arrayBuffer());
        const faceFound = await indexFace(session_id, buf, athlete.id);
        console.log(`[rekognition-index] ${athlete.name}  face_found=${faceFound}`);
        return { indexed: faceFound };
      })
    );

    const indexed = results.filter(
      (r): r is PromiseFulfilledResult<{ indexed: boolean }> =>
        r.status === 'fulfilled' && r.value.indexed
    ).length;

    console.log(`[rekognition-index] done  indexed=${indexed}/${rows.length}`);
    return NextResponse.json({ ok: true, indexed, total: rows.length });
  } catch (err) {
    console.error('[rekognition-index] error:', err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
