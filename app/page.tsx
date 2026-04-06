'use client';

import { useJobStore } from '@/lib/store';
import { SetupForm } from '@/components/stages/SetupForm';
import { ScrapingState } from '@/components/stages/ScrapingState';
import { RosterConfirmation } from '@/components/stages/RosterConfirmation';
import { PhotoUpload } from '@/components/stages/PhotoUpload';
import { ProcessingProgress } from '@/components/stages/ProcessingProgress';
import { Results } from '@/components/stages/Results';
import { ErrorState } from '@/components/stages/ErrorState';

export default function Home() {
  const state = useJobStore((s) => s.state);

  switch (state) {
    case 'setup':        return <SetupForm />;
    case 'scraping':     return <ScrapingState />;
    case 'roster_ready': return <RosterConfirmation />;
    case 'uploading':    return <PhotoUpload />;
    case 'processing':   return <ProcessingProgress />;
    case 'complete':     return <Results />;
    case 'error':        return <ErrorState />;
  }
}
