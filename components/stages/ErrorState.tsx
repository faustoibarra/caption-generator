'use client';

import { useJobStore } from '@/lib/store';

export function ErrorState() {
  const { errorMessage, reset } = useJobStore();

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-4 max-w-md">
        <p className="text-sm text-muted-foreground uppercase tracking-wide">state: error</p>
        <h1 className="text-2xl font-semibold text-destructive">Something went wrong</h1>
        {errorMessage && (
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
        )}
        <button
          onClick={reset}
          className="text-sm underline underline-offset-4"
        >
          Start over
        </button>
      </div>
    </main>
  );
}
