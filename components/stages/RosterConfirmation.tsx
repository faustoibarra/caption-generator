'use client';

import { Button } from '@/components/ui/button';
import { useJobStore } from '@/lib/store';

export function RosterConfirmation() {
  const {
    jobName,
    sport,
    hasJerseyNumbers,
    athletes,
    sessionId,
    rosterUrl,
    setAthletes,
    startScraping,
    setRosterReady,
    setUploading,
    setError,
  } = useJobStore();

  async function handleRescrape() {
    // Transition to scraping spinner, then rescrape in background
    startScraping();
    try {
      const res = await fetch('/api/rescrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          roster_url: rosterUrl,
          sport,
          has_jersey_numbers: hasJerseyNumbers,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `Server error: ${res.status}`);
      setAthletes(data.athletes);
      setRosterReady();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-scrape failed.');
    }
  }

  return (
    <main className="min-h-screen p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">
          Confirm Roster — {jobName} {sport}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {athletes.length} athlete{athletes.length !== 1 ? 's' : ''} found
        </p>
      </div>

      {/* Empty-state warning */}
      {athletes.length === 0 && (
        <div className="mb-6 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          No athletes found. This may be a JS-rendered page. Try re-scraping or check the URL.
        </div>
      )}

      {/* Athlete grid */}
      {athletes.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 mb-8">
          {athletes.map((athlete) => (
            <div
              key={athlete.id}
              className="flex flex-col items-center gap-2 rounded-lg border bg-card p-3 text-center"
            >
              {/* Headshot or placeholder */}
              {athlete.headshot_url ? (
                <img
                  src={athlete.headshot_url}
                  alt={athlete.name}
                  className="h-20 w-20 rounded-full object-cover bg-muted"
                />
              ) : (
                <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-2xl select-none">
                  {athlete.name.charAt(0)}
                </div>
              )}

              <p className="text-xs font-medium leading-tight">{athlete.name}</p>

              {hasJerseyNumbers && athlete.jersey_number && (
                <span className="text-xs text-muted-foreground">#{athlete.jersey_number}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={handleRescrape}>
          Re-scrape
        </Button>
        <Button onClick={() => setUploading()}>
          Looks good, continue →
        </Button>
      </div>
    </main>
  );
}
