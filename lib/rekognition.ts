import {
  RekognitionClient,
  CreateCollectionCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  DetectFacesCommand,
  DeleteCollectionCommand,
} from '@aws-sdk/client-rekognition';
import sharp from 'sharp';

function getClient(): RekognitionClient {
  return new RekognitionClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
}

export async function createCollection(collectionId: string): Promise<void> {
  const client = getClient();
  try {
    await client.send(new CreateCollectionCommand({ CollectionId: collectionId }));
  } catch (err) {
    if (err instanceof Error && err.name === 'ResourceAlreadyExistsException') return;
    throw err;
  }
}

// Returns true if a face was detected and indexed, false if no face found in image.
export async function indexFace(
  collectionId: string,
  imageBytes: Buffer,
  athleteId: string,
): Promise<boolean> {
  const client = getClient();
  const result = await client.send(new IndexFacesCommand({
    CollectionId: collectionId,
    Image: { Bytes: imageBytes },
    ExternalImageId: athleteId,
    MaxFaces: 1,
    DetectionAttributes: [],
  }));
  const found = (result.FaceRecords?.length ?? 0) > 0;
  const unindexed = result.UnindexedFaces?.length ?? 0;
  console.log(`[rekognition] indexFace collection=${collectionId} athlete=${athleteId} face_found=${found} unindexed=${unindexed}`);
  return found;
}

export interface FaceMatch {
  athleteId: string;
  similarity: number;    // 0–1
  boundingBoxLeft: number; // 0–1, for left-to-right ordering
}

// Detects ALL faces in the image, crops each one, searches the collection for
// each crop, and returns de-duped matches (highest similarity wins per athlete).
// Returns [] if no faces are detected.
export async function searchFacesByImage(
  collectionId: string,
  imageBytes: Buffer,
  confidenceThreshold: number, // 0–1; converted to 0–100 for Rekognition
): Promise<FaceMatch[]> {
  const client = getClient();

  // 1. Detect all faces in the photo
  const detectResult = await client.send(new DetectFacesCommand({
    Image: { Bytes: imageBytes },
  }));
  const faceDetails = detectResult.FaceDetails ?? [];
  console.log(`[rekognition] searchFaces collection=${collectionId} detected_faces=${faceDetails.length}`);

  if (faceDetails.length === 0) return [];

  // 2. Get image dimensions for cropping
  const metadata = await sharp(imageBytes).metadata();
  const imgWidth = metadata.width ?? 0;
  const imgHeight = metadata.height ?? 0;

  // 3. Crop each face (with 30% padding) and search the collection in parallel
  const PADDING = 0.3;
  const searchResults = await Promise.allSettled(
    faceDetails.map(async (face, i) => {
      const bb = face.BoundingBox;
      if (!bb?.Left || !bb?.Top || !bb?.Width || !bb?.Height) return null;

      const padW = bb.Width  * PADDING;
      const padH = bb.Height * PADDING;
      const left   = Math.max(0, (bb.Left - padW) * imgWidth);
      const top    = Math.max(0, (bb.Top  - padH) * imgHeight);
      const width  = Math.min(imgWidth  - left, (bb.Width  + 2 * padW) * imgWidth);
      const height = Math.min(imgHeight - top,  (bb.Height + 2 * padH) * imgHeight);

      const crop = await sharp(imageBytes)
        .extract({ left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) })
        .jpeg({ quality: 90 })
        .toBuffer();

      try {
        const result = await client.send(new SearchFacesByImageCommand({
          CollectionId: collectionId,
          Image: { Bytes: crop },
          FaceMatchThreshold: confidenceThreshold * 100,
          MaxFaces: 1,
        }));
        const match = result.FaceMatches?.[0];
        if (!match?.Face?.ExternalImageId) return null;
        console.log(`[rekognition] face[${i}] athlete=${match.Face.ExternalImageId} similarity=${(match.Similarity ?? 0).toFixed(1)}`);
        return {
          athleteId: match.Face.ExternalImageId,
          similarity: (match.Similarity ?? 0) / 100,
          boundingBoxLeft: bb.Left,
        } satisfies FaceMatch;
      } catch (err) {
        if (err instanceof Error && err.name === 'InvalidParameterException') return null; // no face in crop
        throw err;
      }
    })
  );

  // 4. Collect results, de-dup by athleteId (keep highest similarity)
  const best = new Map<string, FaceMatch>();
  for (const r of searchResults) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const m = r.value;
    const existing = best.get(m.athleteId);
    if (!existing || m.similarity > existing.similarity) {
      best.set(m.athleteId, m);
    }
  }

  const matches = [...best.values()];
  console.log(`[rekognition] searchFaces collection=${collectionId} matched_athletes=${matches.length}`);
  return matches;
}

export async function deleteCollection(collectionId: string): Promise<void> {
  const client = getClient();
  try {
    await client.send(new DeleteCollectionCommand({ CollectionId: collectionId }));
  } catch (err) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') return;
    throw err;
  }
}
