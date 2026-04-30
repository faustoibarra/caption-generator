import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const rosterUrl = req.nextUrl.searchParams.get('roster_url');
  console.log(`[check-roster] called url=${rosterUrl}`);
  if (!rosterUrl) {
    return NextResponse.json({ ok: false, error: 'roster_url is required' }, { status: 400 });
  }

  try {
    const supabase = createServiceClient();

    // Normalize URL: trim whitespace and trailing slashes so minor variations still match
    const normalizedUrl = rosterUrl.trim().replace(/\/+$/, '');

    // Use .ilike() instead of .eq() — PostgREST has a quirk where .eq() values
    // containing special chars (`:`, `/`, `.`) can fail to match even when the
    // value is identical. .ilike() with no wildcards works as exact-match.
    const { data: rows, error } = await supabase
      .from('roster_athletes')
      .select('id, session_id, name, jersey_number, headshot_url, created_at')
      .ilike('roster_url', normalizedUrl)
      .order('created_at', { ascending: false })
      .limit(200);

    console.log(`[check-roster] url=${normalizedUrl} normalized_len=${normalizedUrl.length} rows=${rows?.length ?? 0} err=${error?.message ?? 'none'}`);

    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) {
      return NextResponse.json({ ok: true, exists: false });
    }

    // All rows from the most recent session
    interface RosterRow { id: string; session_id: string; name: string; jersey_number: string | null; headshot_url: string | null; }
    const sessionId = rows[0].session_id;
    const sessionRows = (rows as RosterRow[]).filter((r) => r.session_id === sessionId);

    // Generate signed URLs for headshots
    let signFailures = 0;
    let firstFailureMsg = '';
    let firstFailurePath = '';
    const athletes = await Promise.all(
      sessionRows.map(async (row: RosterRow) => {
        let signedUrl: string | null = null;
        if (row.headshot_url) {
          const { data: signed, error: signErr } = await supabase.storage
            .from('rosters')
            .createSignedUrl(row.headshot_url, 3600);
          if (signErr || !signed?.signedUrl) {
            signFailures++;
            if (!firstFailureMsg) {
              firstFailureMsg = signErr?.message ?? 'no signedUrl returned';
              firstFailurePath = row.headshot_url;
            }
          }
          signedUrl = signed?.signedUrl ?? null;
        }
        return {
          id: row.id,
          name: row.name,
          jersey_number: row.jersey_number ?? null,
          headshot_url: signedUrl,
        };
      })
    );
    console.log(`[check-roster] sign_failures=${signFailures}/${sessionRows.length} first_failure_path=${firstFailurePath} first_failure_msg=${firstFailureMsg}`);

    // If every headshot file is missing from storage, the roster is unusable —
    // treat it as not-existing so the user is forced to rescrape and repopulate.
    const headshotsExpected = sessionRows.filter((r) => r.headshot_url).length;
    if (headshotsExpected > 0 && signFailures === headshotsExpected) {
      console.log(`[check-roster] all headshots missing — returning exists=false to force rescrape`);
      return NextResponse.json({ ok: true, exists: false });
    }

    return NextResponse.json({ ok: true, exists: true, session_id: sessionId, athletes });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
