import {
  RekognitionClient,
  CreateCollectionCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  DeleteCollectionCommand,
} from '@aws-sdk/client-rekognition';

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

// Returns matches sorted by nothing — caller sorts by boundingBoxLeft.
// Returns [] if no faces detected in input image.
export async function searchFacesByImage(
  collectionId: string,
  imageBytes: Buffer,
  confidenceThreshold: number, // 0–1; converted to 0–100 for Rekognition
): Promise<FaceMatch[]> {
  const client = getClient();
  try {
    const result = await client.send(new SearchFacesByImageCommand({
      CollectionId: collectionId,
      Image: { Bytes: imageBytes },
      FaceMatchThreshold: confidenceThreshold * 100,
      MaxFaces: 10,
    }));
    const searchedConf = result.SearchedFaceConfidence ?? 0;
    const rawMatches = result.FaceMatches ?? [];
    console.log(
      `[rekognition] searchFaces collection=${collectionId}` +
      ` searched_face_confidence=${searchedConf.toFixed(1)}` +
      ` threshold=${(confidenceThreshold * 100).toFixed(0)}` +
      ` raw_matches=${rawMatches.length}` +
      (rawMatches.length > 0
        ? ` top_similarity=${(rawMatches[0].Similarity ?? 0).toFixed(1)} id=${rawMatches[0].Face?.ExternalImageId}`
        : '')
    );
    return rawMatches
      .filter((m) => m.Face?.ExternalImageId)
      .map((m) => ({
        athleteId: m.Face!.ExternalImageId!,
        similarity: (m.Similarity ?? 0) / 100,
        boundingBoxLeft: m.Face?.BoundingBox?.Left ?? 0,
      }));
  } catch (err) {
    // Rekognition throws InvalidParameterException when no faces are detected in the input image
    if (err instanceof Error && err.name === 'InvalidParameterException') {
      console.log(`[rekognition] searchFaces collection=${collectionId} — no faces detected in image`);
      return [];
    }
    console.error(`[rekognition] searchFaces error collection=${collectionId}:`, err);
    throw err;
  }
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
