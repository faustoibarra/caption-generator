'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useJobStore } from '@/lib/store';
import type { Athlete } from '@/lib/store';

export function SetupForm() {
  const { setSetup, startScraping, setAthletes, setRosterReady, setUploading, setError } = useJobStore();

  const [jobName, setJobName] = useState('');
  const [rosterUrl, setRosterUrl] = useState('');
  const [sport, setSport] = useState('');
  const [hasJerseyNumbers, setHasJerseyNumbers] = useState(false);
  const [recognitionEngine, setRecognitionEngine] = useState<'claude' | 'rekognition'>('rekognition');
  const [rosterScrapingMethod, setRosterScrapingMethod] = useState<'programmatic' | 'claude'>('programmatic');
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.98);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Existing-roster prompt state
  const [existingRoster, setExistingRoster] = useState<{
    sessionId: string;
    athletes: Athlete[];
  } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (!jobName.trim() || !rosterUrl.trim() || !sport.trim()) {
      setValidationError('All text fields are required.');
      return;
    }
    if (!rosterUrl.startsWith('http')) {
      setValidationError('Roster URL must start with http.');
      return;
    }

    setSubmitting(true);
    try {
      // Check if a roster already exists for this URL
      const checkRes = await fetch(
        `/api/check-roster?roster_url=${encodeURIComponent(rosterUrl)}`
      );
      const checkData = await checkRes.json();
      if (!checkData.ok) throw new Error(checkData.error || 'Failed to check existing roster.');

      if (checkData.exists) {
        // Show existing roster and ask the user
        setExistingRoster({ sessionId: checkData.session_id, athletes: checkData.athletes });
        return;
      }

      // No existing roster — go straight to scraping
      await scrapeAndContinue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setSubmitting(false);
    }
  }

  async function scrapeAndContinue(rescrape = false) {
    const sessionId = crypto.randomUUID();
    setSetup({ jobName, rosterUrl, sport, hasJerseyNumbers, recognitionEngine, rosterScrapingMethod, confidenceThreshold, sessionId });
    setSubmitting(true);

    const MAX_ATTEMPTS = rosterScrapingMethod === 'programmatic' ? 1 : 5;
    let lastError: Error = new Error('Unknown error during roster scraping.');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const msg = attempt === 1
        ? (rosterScrapingMethod === 'programmatic' ? 'Scraping roster…' : undefined)
        : `Claude timed out — retrying (${attempt} of ${MAX_ATTEMPTS})…`;
      startScraping(msg);

      try {
        const res = await fetch('/api/scrape-roster', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            roster_url: rosterUrl,
            sport,
            has_jersey_numbers: hasJerseyNumbers,
            recognition_engine: recognitionEngine,
            roster_scraping_method: rosterScrapingMethod,
            rescrape,
          }),
        });

        let data: { ok: boolean; athletes?: { id: string; name: string; jersey_number: string | null; headshot_url: string | null }[]; error?: string };
        try {
          data = await res.json();
        } catch {
          throw new Error('Claude timed out');
        }

        if (!data.ok) throw new Error(data.error || `Server error: ${res.status}`);
        setAthletes(data.athletes ?? []);
        setRosterReady();
        setSubmitting(false);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error('Unknown error during roster scraping.');
      }
    }

    setError(lastError.message);
    setSubmitting(false);
  }

  async function useExistingRoster() {
    if (!existingRoster) return;
    setSetup({
      jobName,
      rosterUrl,
      sport,
      hasJerseyNumbers,
      recognitionEngine,
      rosterScrapingMethod,
      confidenceThreshold,
      sessionId: existingRoster.sessionId,
    });
    setAthletes(existingRoster.athletes);

    if (recognitionEngine === 'rekognition') {
      startScraping('Indexing faces from existing roster…');
      try {
        const res = await fetch('/api/rekognition-index', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: existingRoster.sessionId }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Failed to index faces.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Face indexing failed.');
        return;
      }
    }

    setUploading();
  }

  async function handleReload() {
    setExistingRoster(null);
    setSubmitting(true);
    try {
      await scrapeAndContinue(true);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Existing-roster confirmation panel ──────────────────────────────────────
  if (existingRoster) {
    return (
      <main className="min-h-screen p-8 max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">Roster already loaded</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Found {existingRoster.athletes.length} athlete
            {existingRoster.athletes.length !== 1 ? 's' : ''} from a previous scrape of this URL.
            Use the existing roster or reload it fresh from the site.
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 mb-8">
          {existingRoster.athletes.map((athlete) => (
            <div
              key={athlete.id}
              className="flex flex-col items-center gap-2 rounded-lg border bg-card p-3 text-center"
            >
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

        <div className="flex gap-3">
          <Button variant="outline" onClick={handleReload} disabled={submitting}>
            Reload from site
          </Button>
          <Button onClick={useExistingRoster}>
            Use existing roster → Upload Photos
          </Button>
        </div>
      </main>
    );
  }

  // ── Setup form ───────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-2xl">Caption Generator</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="jobName">Job Name</Label>
              <Input
                id="jobName"
                placeholder="Stanford Field Hockey 2025-03-15"
                value={jobName}
                onChange={(e) => setJobName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sport">Sport</Label>
              <Input
                id="sport"
                placeholder="Field Hockey"
                value={sport}
                onChange={(e) => setSport(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rosterUrl">Roster URL</Label>
              <Input
                id="rosterUrl"
                type="url"
                placeholder="https://..."
                value={rosterUrl}
                onChange={(e) => setRosterUrl(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>Roster Scraping</Label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="rosterScrapingMethod"
                    value="programmatic"
                    checked={rosterScrapingMethod === 'programmatic'}
                    onChange={() => setRosterScrapingMethod('programmatic')}
                    className="accent-primary"
                  />
                  <span className="text-sm">Programmatic</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="rosterScrapingMethod"
                    value="claude"
                    checked={rosterScrapingMethod === 'claude'}
                    onChange={() => setRosterScrapingMethod('claude')}
                    className="accent-primary"
                  />
                  <span className="text-sm">Claude AI</span>
                </label>
              </div>
              {rosterScrapingMethod === 'programmatic' && (
                <p className="text-xs text-muted-foreground">Fast, free — works for gostanford.com rosters</p>
              )}
              {rosterScrapingMethod === 'claude' && (
                <p className="text-xs text-muted-foreground">Uses Claude API — slower but handles any roster format</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Recognition Engine</Label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="recognitionEngine"
                    value="claude"
                    checked={recognitionEngine === 'claude'}
                    onChange={() => { setRecognitionEngine('claude'); setConfidenceThreshold(0.9); }}
                    className="accent-primary"
                  />
                  <span className="text-sm">Claude Vision</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="recognitionEngine"
                    value="rekognition"
                    checked={recognitionEngine === 'rekognition'}
                    onChange={() => { setRecognitionEngine('rekognition'); setConfidenceThreshold(0.98); }}
                    className="accent-primary"
                  />
                  <span className="text-sm">AWS Rekognition</span>
                </label>
              </div>
              {recognitionEngine === 'rekognition' && (
                <p className="text-xs text-muted-foreground">Face matching only — jersey number matching unavailable</p>
              )}
            </div>

            {recognitionEngine === 'claude' && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="hasJerseyNumbers"
                  checked={hasJerseyNumbers}
                  onCheckedChange={(checked) => setHasJerseyNumbers(checked === true)}
                />
                <Label htmlFor="hasJerseyNumbers" className="cursor-pointer">
                  Has Jersey Numbers
                </Label>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="confidenceThreshold">Confidence Threshold</Label>
              <Input
                id="confidenceThreshold"
                type="number"
                min={0.2}
                max={1.0}
                step={0.01}
                value={confidenceThreshold}
                onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Matches below this level will show their confidence % in the Personality field when that option is selected at download
              </p>
            </div>

            {validationError && (
              <p className="text-sm text-destructive">{validationError}</p>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Checking…' : 'Start →'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
