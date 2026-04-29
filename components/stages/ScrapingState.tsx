'use client';

import { useJobStore } from '@/lib/store';

export function ScrapingState() {
  const reset = useJobStore((s) => s.reset);
  const recognitionEngine = useJobStore((s) => s.recognitionEngine);
  const scrapingMessage = useJobStore((s) => s.scrapingMessage);

  const message = scrapingMessage
    ?? (recognitionEngine === 'rekognition' ? 'Scraping roster and indexing faces...' : 'Scraping roster...');

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-4">
        <p className="text-sm text-muted-foreground uppercase tracking-wide">state: scraping</p>
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-lg font-medium">
          {message}
        </p>
        <button
          onClick={reset}
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          Cancel
        </button>
      </div>
    </main>
  );
}
