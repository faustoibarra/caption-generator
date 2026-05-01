'use client';

import { create } from 'zustand';

export type JobState =
  | 'setup'
  | 'scraping'
  | 'roster_ready'
  | 'uploading'
  | 'processing'
  | 'complete'
  | 'error';

export interface Athlete {
  id: string;
  name: string;
  jersey_number: string | null;
  headshot_url: string | null;
}

export interface BatchPhotoMeta {
  filename: string;
  thumbnailUrl: string | null;
}

export interface CumulativeStats {
  total: number;
  matched: number;
  unmatched: number;
  batches: number;
}

interface JobStore {
  state: JobState;
  sessionId: string | null;
  jobName: string;
  rosterUrl: string;
  sport: string;
  hasJerseyNumbers: boolean;
  recognitionEngine: 'claude' | 'rekognition';
  rosterScrapingMethod: 'programmatic' | 'claude';
  confidenceThreshold: number;
  errorMessage: string | null;
  scrapingMessage: string | null;
  athletes: Athlete[];
  uploadedPhotoIds: string[];
  currentBatchPhotoIds: string[];
  currentBatchPhotoMeta: Record<string, BatchPhotoMeta>;
  batchNumber: number;
  cumulativeStats: CumulativeStats | null;

  setSetup: (fields: {
    jobName: string;
    rosterUrl: string;
    sport: string;
    hasJerseyNumbers: boolean;
    recognitionEngine: 'claude' | 'rekognition';
    rosterScrapingMethod: 'programmatic' | 'claude';
    confidenceThreshold: number;
    sessionId: string;
  }) => void;
  startScraping: (message?: string) => void;
  setAthletes: (athletes: Athlete[]) => void;
  setRosterReady: () => void;
  addUploadedPhoto: (id: string) => void;
  setUploading: () => void;
  setProcessing: (batchPhotoIds: string[], batchPhotoMeta: Record<string, BatchPhotoMeta>) => void;
  startNextBatch: () => void;
  finishBatch: (stats: { total: number; matched: number; unmatched: number }) => void;
  finishJob: () => void;
  setComplete: () => void;
  setError: (message: string) => void;
  reset: () => void;
}

const initialState = {
  state: 'setup' as JobState,
  sessionId: null,
  jobName: '',
  rosterUrl: '',
  sport: '',
  hasJerseyNumbers: false,
  recognitionEngine: 'rekognition' as 'claude' | 'rekognition',
  rosterScrapingMethod: 'programmatic' as 'programmatic' | 'claude',
  confidenceThreshold: 0.98,
  errorMessage: null,
  scrapingMessage: null,
  athletes: [],
  uploadedPhotoIds: [],
  currentBatchPhotoIds: [],
  currentBatchPhotoMeta: {},
  batchNumber: 1,
  cumulativeStats: null,
};

export const useJobStore = create<JobStore>((set) => ({
  ...initialState,

  setSetup: (fields) =>
    set({
      sessionId: fields.sessionId,
      jobName: fields.jobName,
      rosterUrl: fields.rosterUrl,
      sport: fields.sport,
      hasJerseyNumbers: fields.hasJerseyNumbers,
      recognitionEngine: fields.recognitionEngine,
      rosterScrapingMethod: fields.rosterScrapingMethod,
      confidenceThreshold: fields.confidenceThreshold,
      errorMessage: null,
    }),

  startScraping: (message) => set({ state: 'scraping', scrapingMessage: message ?? null }),

  setAthletes: (athletes) => set({ athletes }),

  setRosterReady: () => set({ state: 'roster_ready' }),

  addUploadedPhoto: (id) =>
    set((s) => ({ uploadedPhotoIds: [...s.uploadedPhotoIds, id] })),

  setUploading: () => set({ state: 'uploading' }),

  setProcessing: (batchPhotoIds, batchPhotoMeta) =>
    set({ state: 'processing', currentBatchPhotoIds: batchPhotoIds, currentBatchPhotoMeta: batchPhotoMeta }),

  startNextBatch: () =>
    set((s) => ({
      state: 'uploading',
      currentBatchPhotoIds: [],
      currentBatchPhotoMeta: {},
      batchNumber: s.batchNumber + 1,
    })),

  finishBatch: (stats) =>
    set((s) => ({
      cumulativeStats: {
        total: stats.total,
        matched: stats.matched,
        unmatched: stats.unmatched,
        batches: s.batchNumber,
      },
    })),

  finishJob: () => set({ state: 'complete' }),

  setComplete: () => set({ state: 'complete' }),

  setError: (message) => set({ state: 'error', errorMessage: message }),

  reset: () => set({ ...initialState }),
}));
