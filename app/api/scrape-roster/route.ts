import { NextRequest, NextResponse } from 'next/server';
import { scrapeRoster } from '@/lib/scrape-roster';
import { scrapeRosterProgrammatic } from '@/lib/scrape-roster-programmatic';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const {
      session_id,
      roster_url,
      sport,
      has_jersey_numbers,
      rescrape,
      recognition_engine,
      roster_scraping_method,
    } = await req.json();

    const athletes = roster_scraping_method === 'claude'
      ? await scrapeRoster(session_id, roster_url, sport, has_jersey_numbers, rescrape ?? false, recognition_engine ?? 'claude')
      : await scrapeRosterProgrammatic(session_id, roster_url, sport, has_jersey_numbers, rescrape ?? false, recognition_engine ?? 'claude');

    return NextResponse.json({ ok: true, athletes });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
