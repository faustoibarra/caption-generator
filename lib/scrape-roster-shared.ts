import { createServiceClient } from '@/lib/supabase/server';
import { createCollection, indexFace } from '@/lib/rekognition';
import type { AthleteResult } from '@/lib/scrape-roster';

export interface RawAthlete {
  name: string;
  jersey_number: string | null;
  headshot_url: string | null;
}

function elapsed(start: number) {
  return `${((Date.now() - start) / 1000).toFixed(2)}s`;
}

export async function processAthletes(
  rawAthletes: RawAthlete[],
  sessionId: string,
  rosterUrl: string,
  rescrape: boolean,
  recognitionEngine: 'claude' | 'rekognition',
): Promise<AthleteResult[]> {
  const t0 = Date.now();

  const supabase = createServiceClient();

  if (rescrape) {
    const { error: delError } = await supabase
      .from('roster_athletes')
      .delete()
      .eq('roster_url', rosterUrl);
    if (delError) {
      console.warn(`[process-athletes] Failed to delete existing athletes: ${delError.message}`);
    } else {
      console.log(`[process-athletes] Deleted existing athletes for url=${rosterUrl}`);
    }
  }

  if (recognitionEngine === 'rekognition') {
    const tc = Date.now();
    await createCollection(sessionId);
    console.log(`[process-athletes] Rekognition collection created  session=${sessionId}  time=${elapsed(tc)}`);
  }

  const settled = await Promise.allSettled(
    rawAthletes.map(async (raw, i) => {
      const ta = Date.now();
      const athleteId = crypto.randomUUID();
      let storagePath: string | null = null;
      let headshotBuffer: Buffer | null = null;

      if (raw.headshot_url) {
        try {
          const td = Date.now();
          const imgRes = await fetch(raw.headshot_url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          const downloadMs = Date.now() - td;
          if (imgRes.ok) {
            const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
            const tu = Date.now();
            const storageKey = `${sessionId}/${athleteId}.jpg`;
            const { error: uploadError } = await supabase.storage
              .from('rosters')
              .upload(storageKey, imgBuffer, { contentType: 'image/jpeg', upsert: true });
            const uploadMs = Date.now() - tu;
            if (!uploadError) {
              storagePath = storageKey;
              headshotBuffer = imgBuffer;
              console.log(`[process-athletes] [${i + 1}/${rawAthletes.length}] ${raw.name}  download=${downloadMs}ms  upload=${uploadMs}ms  size=${imgBuffer.length}B`);
            } else {
              console.warn(`[process-athletes] [${i + 1}/${rawAthletes.length}] ${raw.name}  storage upload error: ${uploadError.message}`);
            }
          } else {
            console.warn(`[process-athletes] [${i + 1}/${rawAthletes.length}] ${raw.name}  headshot fetch ${imgRes.status}`);
          }
        } catch (err) {
          console.warn(`[process-athletes] [${i + 1}/${rawAthletes.length}] ${raw.name}  headshot exception: ${err instanceof Error ? err.message : err}`);
        }
      }

      const { error: dbError } = await supabase.from('roster_athletes').insert({
        id: athleteId,
        session_id: sessionId,
        roster_url: rosterUrl,
        name: raw.name,
        jersey_number: raw.jersey_number ?? null,
        headshot_url: storagePath,
      });

      if (dbError) {
        console.error(`[process-athletes] [${i + 1}/${rawAthletes.length}] ${raw.name}  DB insert failed:`, JSON.stringify(dbError));
        throw new Error(dbError.message);
      }

      if (recognitionEngine === 'rekognition' && storagePath && headshotBuffer) {
        try {
          const ti = Date.now();
          const faceFound = await indexFace(sessionId, headshotBuffer, athleteId);
          console.log(`[process-athletes] [${i + 1}/${rawAthletes.length}] ${raw.name}  rekognition index  face_found=${faceFound}  time=${Date.now() - ti}ms`);
        } catch (rekErr) {
          console.warn(`[process-athletes] [${i + 1}/${rawAthletes.length}] ${raw.name}  rekognition index error: ${rekErr instanceof Error ? rekErr.message : rekErr}`);
        }
      }

      let signedUrl: string | null = null;
      if (storagePath) {
        const { data: signed } = await supabase.storage
          .from('rosters')
          .createSignedUrl(storagePath, 3600);
        signedUrl = signed?.signedUrl ?? null;
      }

      console.log(`[process-athletes] [${i + 1}/${rawAthletes.length}] ${raw.name}  done  time=${elapsed(ta)}`);

      return {
        id: athleteId,
        name: raw.name,
        jersey_number: raw.jersey_number ?? null,
        headshot_url: signedUrl,
      } satisfies AthleteResult;
    })
  );

  const results: AthleteResult[] = settled
    .filter((r): r is PromiseFulfilledResult<AthleteResult> => r.status === 'fulfilled')
    .map((r) => r.value);

  console.log(`[process-athletes] DONE  athletes=${results.length}/${rawAthletes.length}  total=${elapsed(t0)}`);
  return results;
}
