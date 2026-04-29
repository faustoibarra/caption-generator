import { NextRequest, NextResponse } from 'next/server';
import { scrapeRoster } from '@/lib/scrape-roster';
import { createServiceClient } from '@/lib/supabase/server';
import { deleteCollection } from '@/lib/rekognition';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { session_id, roster_url, sport, has_jersey_numbers, recognition_engine } = await req.json();
    const supabase = createServiceClient();

    // Delete existing DB rows
    const { error: deleteRowsError } = await supabase
      .from('roster_athletes')
      .delete()
      .eq('session_id', session_id);
    if (deleteRowsError) {
      console.error('Failed to delete roster_athletes rows:', deleteRowsError.message);
    }

    // Delete existing storage files
    const { data: existingFiles } = await supabase.storage
      .from('rosters')
      .list(session_id);
    if (existingFiles && existingFiles.length > 0) {
      const paths = existingFiles.map((f: { name: string }) => `${session_id}/${f.name}`);
      await supabase.storage.from('rosters').remove(paths);
    }

    // If Rekognition mode, delete the existing collection before re-scraping
    if (recognition_engine === 'rekognition') {
      await deleteCollection(session_id);
      console.log(`[rescrape] Deleted Rekognition collection  session=${session_id}`);
    }

    // Re-run scraping
    const athletes = await scrapeRoster(session_id, roster_url, sport, has_jersey_numbers, false, recognition_engine ?? 'claude');
    return NextResponse.json({ ok: true, athletes });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
