import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { createServiceClient } from '@/lib/supabase/server';
import { writeAthleteNames } from '@/lib/xmp-writer';

export const maxDuration = 300;

const anthropic = new Anthropic();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessBody {
  confidence_threshold: number;
  has_jersey_numbers: boolean;
  sport: string;
}

interface FaceMatch {
  name: string;
  face_confidence: number;
  position_x: number;
}

interface JerseyMatch {
  name: string;
  jersey_number: string;
  jersey_confidence: number;
  position_x: number;
}

interface MergedAthlete {
  name: string;
  face_confidence: number | null;
  jersey_confidence: number | null;
  position_x: number;
  match_type: 'face' | 'jersey' | 'both';
}

interface RosterAthlete {
  id: string;
  name: string;
  jersey_number: string | null;
  headshot_url: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base URL for internal function-to-function calls. */
function internalBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

async function callClaudeJerseys(
  sport: string,
  rosterLines: string,
  photoBase64: string
): Promise<JerseyMatch[]> {
  type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } };

  const content: Block[] = [
    {
      type: 'text',
      text: `You are reading jersey numbers from a sports photograph.

The sport is: ${sport}

Here is the team roster (name: jersey number):
${rosterLines}

Look at this event photo and identify any athletes you can match by their jersey number.
For each jersey number you can clearly read:
- Match it to an athlete in the roster above
- Estimate the athlete's horizontal position in the frame (0 = far left, 1 = far right)
- Rate your confidence in the jersey number reading (0–1)

Return JSON only, in this exact format:
{
  "jerseys": [
    {
      "name": "Athlete Name",
      "jersey_number": "23",
      "jersey_confidence": 0.92,
      "position_x": 0.4
    }
  ]
}

Only include athletes where you can clearly read a jersey number.
Do not guess. If no jersey numbers are readable, return: { "jerseys": [] }`,
    },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: photoBase64 },
    },
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content }],
  });

  const block = response.content[0];
  if (block.type !== 'text') return [];

  try {
    const jsonMatch = block.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    return (parsed.jerseys ?? []) as JerseyMatch[];
  } catch {
    return [];
  }
}

async function callClaudeJerseysWithRetry(
  sport: string,
  rosterLines: string,
  photoBase64: string
): Promise<JerseyMatch[]> {
  try {
    return await callClaudeJerseys(sport, rosterLines, photoBase64);
  } catch {
    try {
      return await callClaudeJerseys(sport, rosterLines, photoBase64);
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: ProcessBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { confidence_threshold, has_jersey_numbers, sport } = body;
  const supabase = createServiceClient();

  // 1. Look up photo row
  const { data: photo, error: photoErr } = await supabase
    .from('photos')
    .select('id, session_id, storage_path, filename')
    .eq('id', id)
    .single();

  if (photoErr || !photo) {
    return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
  }

  const { session_id, storage_path, filename } = photo;
  await supabase.from('photos').update({ status: 'processing' }).eq('id', id);

  // 2. Download + resize original JPG
  const { data: origBlob, error: origErr } = await supabase.storage
    .from('photos-original')
    .download(storage_path);

  if (origErr || !origBlob) {
    await supabase.from('photos').update({ status: 'error', error_message: 'Failed to download original' }).eq('id', id);
    return NextResponse.json({ error: 'Failed to download original photo' }, { status: 500 });
  }

  const originalBuffer = Buffer.from(await origBlob.arrayBuffer());

  let resizedBuffer: Buffer;
  try {
    resizedBuffer = await sharp(originalBuffer)
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Resize failed';
    await supabase.from('photos').update({ status: 'error', error_message: msg }).eq('id', id);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // 3. Fetch roster athletes
  const { data: athletes, error: rosterErr } = await supabase
    .from('roster_athletes')
    .select('id, name, jersey_number, headshot_url')
    .eq('session_id', session_id);

  if (rosterErr) {
    await supabase.from('photos').update({ status: 'error', error_message: 'Failed to fetch roster' }).eq('id', id);
    return NextResponse.json({ error: 'Failed to fetch roster' }, { status: 500 });
  }

  const rosterAthletes: RosterAthlete[] = athletes ?? [];

  // 4. Download + resize headshots (small, for face-match payload size)
  const headshotData = await Promise.all(
    rosterAthletes.map(async (athlete) => {
      if (!athlete.headshot_url) return { name: athlete.name, headshot_base64: null };
      const { data: blob } = await supabase.storage
        .from('rosters')
        .download(athlete.headshot_url);
      if (!blob) return { name: athlete.name, headshot_base64: null };
      // Resize to max 480px on longest edge — preserves full face, keeps payload small.
      // fit:'inside' never crops; portrait headshots (very common) are kept intact.
      const buf = Buffer.from(await blob.arrayBuffer());
      const small = await sharp(buf)
        .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
        .catch(() => buf);
      return { name: athlete.name, headshot_base64: small.toString('base64') };
    })
  );

  const photoBase64 = resizedBuffer.toString('base64');

  // 5. Call Python face-match function
  let faceMatches: FaceMatch[] = [];
  try {
    const faceResp = await fetch(`${internalBaseUrl()}/api/face-match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_base64: photoBase64, athletes: headshotData }),
      // Allow up to 120s — buffalo_s model download (~67 MB) can take 60-90s on cold start
      signal: AbortSignal.timeout(120_000),
    });
    const faceData = await faceResp.json();
    faceMatches = (faceData.matches ?? []) as FaceMatch[];
  } catch (err) {
    // Face matching unavailable — log and continue with jersey-only
    console.warn('[process] face-match call failed:', err instanceof Error ? err.message : err);
  }

  // 6. Call Claude for jersey numbers (only when jersey numbers are relevant)
  let jerseyMatches: JerseyMatch[] = [];
  if (has_jersey_numbers) {
    const rosterLines = rosterAthletes
      .filter((a) => a.jersey_number)
      .map((a) => `- ${a.name}: #${a.jersey_number}`)
      .join('\n');

    if (rosterLines) {
      jerseyMatches = await callClaudeJerseysWithRetry(sport, rosterLines, photoBase64);
    }
  }

  // 7. Merge face matches + jersey matches per athlete
  const athleteMap: Record<string, MergedAthlete> = {};

  for (const fm of faceMatches) {
    athleteMap[fm.name] = {
      name: fm.name,
      face_confidence: fm.face_confidence,
      jersey_confidence: null,
      position_x: fm.position_x,
      match_type: 'face',
    };
  }

  for (const jm of jerseyMatches) {
    if (athleteMap[jm.name]) {
      // Combine: use face bbox position (more precise), add jersey confidence
      athleteMap[jm.name].jersey_confidence = jm.jersey_confidence;
      athleteMap[jm.name].match_type = 'both';
    } else {
      athleteMap[jm.name] = {
        name: jm.name,
        face_confidence: null,
        jersey_confidence: jm.jersey_confidence,
        position_x: jm.position_x,
        match_type: 'jersey',
      };
    }
  }

  // 8. Filter to athletes meeting confidence threshold (face OR jersey)
  const allAthletes = Object.values(athleteMap);
  const matched = allAthletes.filter(
    (a) =>
      (a.face_confidence ?? 0) >= confidence_threshold ||
      (a.jersey_confidence ?? 0) >= confidence_threshold
  );

  const processedPath = `photos-processed/${session_id}/${filename}`;

  // Generate thumbnail signed URL (original — always available)
  const { data: thumbData } = await supabase.storage
    .from('photos-original')
    .createSignedUrl(storage_path, 3600);
  const thumbnailUrl = thumbData?.signedUrl ?? null;

  if (matched.length > 0) {
    // Sort matched athletes left-to-right
    matched.sort((a, b) => a.position_x - b.position_x);
    const matchedNames = matched.map((a) => a.name);

    const maxFace = Math.max(...matched.map((a) => a.face_confidence ?? 0));
    const maxJersey = Math.max(...matched.map((a) => a.jersey_confidence ?? 0));
    const hasFace = matched.some((a) => (a.face_confidence ?? 0) >= confidence_threshold);
    const hasJersey = matched.some((a) => (a.jersey_confidence ?? 0) >= confidence_threshold);
    const matchType = hasFace && hasJersey ? 'both' : hasFace ? 'face' : 'jersey';

    // Write XMP metadata
    let processedBuffer: Buffer;
    try {
      processedBuffer = await writeAthleteNames(originalBuffer, matchedNames);
    } catch (xmpErr) {
      const isNoXmp = xmpErr instanceof Error && xmpErr.message === 'XMP segment not found';
      const status = isNoXmp ? 'skipped' : 'error';
      const error_message = isNoXmp ? undefined : (xmpErr instanceof Error ? xmpErr.message : 'XMP write failed');
      await supabase.storage.from('photos-processed').upload(processedPath, originalBuffer, { contentType: 'image/jpeg', upsert: true });
      await supabase.from('photos').update({ status, ...(error_message ? { error_message } : {}), processed_path: processedPath }).eq('id', id);
      return NextResponse.json({ status, filename, thumbnail_url: thumbnailUrl });
    }

    await supabase.storage.from('photos-processed').upload(processedPath, processedBuffer, { contentType: 'image/jpeg', upsert: true });

    await supabase.from('photos').update({
      status: 'matched',
      matched_names: matchedNames,
      face_confidence: maxFace > 0 ? maxFace : null,
      jersey_confidence: maxJersey > 0 ? maxJersey : null,
      match_type: matchType,
      processed_path: processedPath,
    }).eq('id', id);

    return NextResponse.json({
      status: 'matched',
      matched_names: matchedNames,
      face_confidence: maxFace > 0 ? maxFace : null,
      jersey_confidence: maxJersey > 0 ? maxJersey : null,
      match_type: matchType,
      filename,
      thumbnail_url: thumbnailUrl,
    });
  }

  // No matches
  await supabase.storage.from('photos-processed').upload(processedPath, originalBuffer, { contentType: 'image/jpeg', upsert: true });
  await supabase.from('photos').update({ status: 'unmatched', processed_path: processedPath }).eq('id', id);

  return NextResponse.json({
    status: 'unmatched',
    matched_names: null,
    face_confidence: null,
    jersey_confidence: null,
    match_type: null,
    filename,
    thumbnail_url: thumbnailUrl,
  });
}
