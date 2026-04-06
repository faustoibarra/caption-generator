import { NextRequest, NextResponse } from 'next/server';
import { scrapeRoster } from '@/lib/scrape-roster';

export async function POST(req: NextRequest) {
  try {
    const { session_id, roster_url, sport, has_jersey_numbers } = await req.json();
    const athletes = await scrapeRoster(session_id, roster_url, sport, has_jersey_numbers);
    return NextResponse.json({ ok: true, athletes });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
