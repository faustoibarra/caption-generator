import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { createServiceClient } from '@/lib/supabase/server';
import { writeAthleteNames } from '@/lib/xmp-writer';
import { searchFacesByImage } from '@/lib/rekognition';

export const maxDuration = 300;

const anthropic = new Anthropic({
  timeout: 120_000,
  maxRetries: 4,
});

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } };

interface ProcessBody {
  confidence_threshold: number;
  has_jersey_numbers: boolean;
  sport: string;
  recognition_engine: 'claude' | 'rekognition';
}

interface ClaudeAthlete {
  name: string;
  face_confidence: number | null;
  jersey_confidence: number | null;
  match_type: string;
  position_x: number;
}

interface RosterAthlete {
  id: string;
  name: string;
  jersey_number: string | null;
  headshot_url: string | null;
}

async function callClaude(content: ContentBlock[]): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content }],
  });
  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Claude response type');
  return block.text;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log(`[process] START id=${id}`);

  let body: ProcessBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { confidence_threshold, has_jersey_numbers, sport, recognition_engine } = body;
  const supabase = createServiceClient();

  // 1. Look up photo row
  const { data: photo, error: photoErr } = await supabase
    .from('photos')
    .select('id, session_id, storage_path, filename')
    .eq('id', id)
    .single();

  if (photoErr || !photo) {
    console.log(`[process] Photo not found id=${id} err=${photoErr?.message}`);
    return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
  }

  const { session_id, storage_path, filename } = photo;
  console.log(`[process] photo found file=${filename} engine=${recognition_engine}`);
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

  // Derive processed path from the UUID-based storage_path to avoid invalid-key errors from
  // filenames containing spaces or other special characters.
  // storage_path = "photos-original/{session_id}/{uuid}.jpg"  →  swap bucket prefix only.
  const processedPath = storage_path.replace(/^photos-original\//, 'photos-processed/');

  // Helper: upload original (unchanged) and mark status
  async function finishUnmatched() {
    await supabase.storage.from('photos-processed').upload(processedPath, originalBuffer, { contentType: 'image/jpeg', upsert: true });
    await supabase.from('photos').update({ status: 'unmatched', processed_path: processedPath }).eq('id', id);
    const { data: thumb } = await supabase.storage.from('photos-original').createSignedUrl(storage_path, 3600);
    return NextResponse.json({ status: 'unmatched', matched_names: null, face_confidence: null, jersey_confidence: null, match_type: null, filename, thumbnail_url: thumb?.signedUrl ?? null });
  }

  // Helper: write XMP, upload, update DB, return response
  async function finishMatched(
    matchedNames: string[],
    faceConfidence: number | null,
    jerseyConfidence: number | null,
    matchType: string,
  ) {
    const { data: thumbData } = await supabase.storage.from('photos-original').createSignedUrl(storage_path, 3600);
    const thumbnailUrl = thumbData?.signedUrl ?? null;

    let processedBuffer: Buffer;
    try {
      processedBuffer = await writeAthleteNames(originalBuffer, matchedNames);
    } catch (xmpErr) {
      const isNoXmp = xmpErr instanceof Error && xmpErr.message === 'XMP segment not found';
      const status = isNoXmp ? 'skipped' : 'error';
      const error_message = isNoXmp ? undefined : (xmpErr instanceof Error ? xmpErr.message : 'XMP write failed');
      await supabase.storage.from('photos-processed').upload(processedPath, originalBuffer, { contentType: 'image/jpeg', upsert: true });
      await supabase.from('photos').update({
        status,
        ...(error_message ? { error_message } : {}),
        processed_path: processedPath,
        ...(isNoXmp ? { matched_names: matchedNames, face_confidence: faceConfidence, jersey_confidence: jerseyConfidence, match_type: matchType } : {}),
      }).eq('id', id);
      return NextResponse.json({
        status,
        filename,
        thumbnail_url: thumbnailUrl,
        ...(isNoXmp ? { matched_names: matchedNames, face_confidence: faceConfidence, jersey_confidence: jerseyConfidence, match_type: matchType } : {}),
      });
    }

    await supabase.storage.from('photos-processed').upload(processedPath, processedBuffer, { contentType: 'image/jpeg', upsert: true });
    await supabase.from('photos').update({
      status: 'matched',
      matched_names: matchedNames,
      face_confidence: faceConfidence,
      jersey_confidence: jerseyConfidence,
      match_type: matchType,
      processed_path: processedPath,
    }).eq('id', id);

    return NextResponse.json({ status: 'matched', matched_names: matchedNames, face_confidence: faceConfidence, jersey_confidence: jerseyConfidence, match_type: matchType, filename, thumbnail_url: thumbnailUrl });
  }

  // ── Rekognition path ─────────────────────────────────────────────────────────
  if (recognition_engine === 'rekognition') {
    console.log(`[process] Calling Rekognition id=${id}`);
    let matches;
    try {
      matches = await searchFacesByImage(session_id, resizedBuffer, confidence_threshold);
      console.log(`[process] Rekognition done id=${id} matches=${matches.length}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Rekognition API error';
      console.log(`[process] Rekognition error id=${id} msg=${msg}`);
      await supabase.storage.from('photos-processed').upload(processedPath, originalBuffer, { contentType: 'image/jpeg', upsert: true });
      await supabase.from('photos').update({ status: 'error', error_message: msg, processed_path: processedPath }).eq('id', id);
      const { data: thumb } = await supabase.storage.from('photos-original').createSignedUrl(storage_path, 3600);
      return NextResponse.json({ status: 'error', filename, thumbnail_url: thumb?.signedUrl ?? null });
    }

    if (matches.length === 0) return finishUnmatched();

    // Look up athlete names from DB (filter by session_id for safety)
    const athleteIds = matches.map((m) => m.athleteId);
    console.log(`[process] DB lookup session=${session_id} athlete_ids=${JSON.stringify(athleteIds)}`);
    const { data: athleteRows, error: athleteErr } = await supabase
      .from('roster_athletes')
      .select('id, name')
      .eq('session_id', session_id)
      .in('id', athleteIds);
    console.log(`[process] DB lookup found=${athleteRows?.length ?? 0} err=${athleteErr?.message ?? 'none'}`);

    if ((athleteRows?.length ?? 0) === 0) {
      // Diagnose: check if athlete exists in any session
      const { data: anyRows } = await supabase
        .from('roster_athletes')
        .select('id, name, session_id')
        .in('id', athleteIds);
      console.log(`[process] DB fallback (any session) found=${anyRows?.length ?? 0} rows=${JSON.stringify(anyRows)}`);
    }

    const sortedMatches = [...matches].sort((a, b) => a.boundingBoxLeft - b.boundingBoxLeft);
    const matchedNames = sortedMatches
      .map((m) => (athleteRows as { id: string; name: string }[] | null)?.find((a) => a.id === m.athleteId)?.name)
      .filter((n): n is string => Boolean(n));

    if (matchedNames.length === 0) return finishUnmatched();

    const maxFaceConfidence = Math.max(...sortedMatches.map((m) => m.similarity));
    return finishMatched(matchedNames, maxFaceConfidence, null, 'face');
  }

  // ── Claude path ──────────────────────────────────────────────────────────────

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

  // 4. Download headshots in parallel
  const headshotData = await Promise.all(
    rosterAthletes.map(async (athlete) => {
      if (!athlete.headshot_url) return { athlete, base64: null };
      const { data: blob } = await supabase.storage.from('rosters').download(athlete.headshot_url);
      if (!blob) return { athlete, base64: null };
      const buf = Buffer.from(await blob.arrayBuffer());
      return { athlete, base64: buf.toString('base64') };
    })
  );

  // 5. Build Claude Vision prompt
  const content: ContentBlock[] = [
    {
      type: 'text',
      text: `You are identifying college athletes in a sports photograph.

The sport is: ${sport}
Jersey numbers are relevant for this sport: ${has_jersey_numbers}

Below are the roster headshots for all athletes on the team.
Each image is labeled with the athlete's name and jersey number (if applicable).
Study each face carefully — you will need to match them to athletes in the event photo.
`,
    },
  ];

  for (const { athlete, base64 } of headshotData) {
    if (!base64) continue;
    const label = athlete.jersey_number
      ? `${athlete.name} (Jersey #${athlete.jersey_number}):`
      : `${athlete.name}:`;
    content.push({ type: 'text', text: label });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
  }

  content.push({ type: 'text', text: 'Now analyze this event photo:' });
  content.push({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: resizedBuffer.toString('base64') },
  });
  content.push({
    type: 'text',
    text: `Identify all athletes visible in the photo. For each athlete:
1. Compare faces in the event photo against the roster headshots above
2. If jersey numbers are relevant, read the jersey number and match it to the roster
3. Note their horizontal position in the frame (for left-to-right ordering)

Return JSON only, in this exact format:
{
  "athletes": [
    {
      "name": "Athlete Name",
      "face_confidence": 0.92,
      "jersey_confidence": 0.88,
      "match_type": "both",
      "position_x": 0.3
    }
  ]
}

Only include athletes you can match to the roster with reasonable confidence.
Do not include opponent athletes.
If no athletes can be identified, return: { "athletes": [] }`,
  });

  // 6. Call Claude
  console.log(`[process] Calling Claude id=${id} headshots=${headshotData.filter(h => h.base64).length}`);
  let claudeText: string;
  try {
    claudeText = await callClaude(content);
    console.log(`[process] Claude done id=${id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Claude API error';
    console.log(`[process] Claude error id=${id} msg=${msg}`);
    await supabase.storage.from('photos-processed').upload(processedPath, originalBuffer, { contentType: 'image/jpeg', upsert: true });
    await supabase.from('photos').update({ status: 'error', error_message: msg, processed_path: processedPath }).eq('id', id);
    const { data: thumb } = await supabase.storage.from('photos-original').createSignedUrl(storage_path, 3600);
    return NextResponse.json({ status: 'error', filename, thumbnail_url: thumb?.signedUrl ?? null });
  }

  // 7. Parse response
  let parsed: { athletes: ClaudeAthlete[] } = { athletes: [] };
  try {
    const jsonMatch = claudeText.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch {
    // stay with empty athletes
  }

  const rawAthletes: ClaudeAthlete[] = parsed.athletes ?? [];

  // 8. Filter to athletes meeting confidence threshold (face OR jersey)
  const matched = rawAthletes.filter(
    (a) => (a.face_confidence ?? 0) >= confidence_threshold || (a.jersey_confidence ?? 0) >= confidence_threshold
  );

  if (matched.length === 0) return finishUnmatched();

  matched.sort((a, b) => a.position_x - b.position_x);
  const matchedNames = matched.map((a) => a.name);
  const maxFace = Math.max(...matched.map((a) => a.face_confidence ?? 0));
  const maxJersey = Math.max(...matched.map((a) => a.jersey_confidence ?? 0));
  const hasFace = matched.some((a) => (a.face_confidence ?? 0) >= confidence_threshold);
  const hasJersey = matched.some((a) => (a.jersey_confidence ?? 0) >= confidence_threshold);
  const matchType = hasFace && hasJersey ? 'both' : hasFace ? 'face' : 'jersey';

  return finishMatched(matchedNames, maxFace > 0 ? maxFace : null, maxJersey > 0 ? maxJersey : null, matchType);
}
