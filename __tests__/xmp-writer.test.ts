import { writeAthleteNames } from '@/lib/xmp-writer';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractXmpXml(buf: Buffer): string {
  const ns = 'http://ns.adobe.com/xap/1.0/\0';
  const nsBuf = Buffer.from(ns, 'binary');
  const pos = buf.indexOf(nsBuf);
  if (pos === -1) throw new Error('XMP segment not found in output buffer');
  const app1Start = pos - 4;
  const segLen = buf.readUInt16BE(app1Start + 2);
  const xmlStart = pos + nsBuf.length;
  const segEnd = app1Start + 2 + segLen;
  return buf.subarray(xmlStart, segEnd).toString('utf8');
}

function getDcDescription(xml: string): string | null {
  // Extract text content of dc:description rdf:li[xml:lang=x-default]
  const match = xml.match(
    /<dc:description>[\s\S]*?<rdf:Alt>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>[\s\S]*?<\/rdf:Alt>[\s\S]*?<\/dc:description>/
  );
  return match ? match[1].trim() : null;
}

function getDcTitle(xml: string): string | null {
  const match = xml.match(
    /<dc:title>[\s\S]*?<rdf:Alt>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>[\s\S]*?<\/rdf:Alt>[\s\S]*?<\/dc:title>/
  );
  return match ? match[1].trim() : null;
}

const FIXTURES = path.join(__dirname, 'fixtures');
const templatePath = path.join(FIXTURES, 'template.jpg');
const noPlaceholderPath = path.join(FIXTURES, 'no-placeholder.jpg');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('xmp-writer', () => {
  it('replaces enter_caption_here in dc:description', async () => {
    const input = fs.readFileSync(templatePath);
    const result = await writeAthleteNames(input, ['Daria Gusarova']);

    const xml = extractXmpXml(result);
    const description = getDcDescription(xml);

    expect(description).toBe('Daria Gusarova');
    expect(xml).not.toContain('enter_caption_here');
  });

  it('sets dc:title to athlete name', async () => {
    const input = fs.readFileSync(templatePath);
    const result = await writeAthleteNames(input, ['Daria Gusarova']);

    const xml = extractXmpXml(result);
    const title = getDcTitle(xml);

    expect(title).toBe('Daria Gusarova');
  });

  it('formats multiple athletes left-to-right with comma and space', async () => {
    const input = fs.readFileSync(templatePath);
    const result = await writeAthleteNames(input, ['Daria Gusarova', 'Emmy Sharp']);

    const xml = extractXmpXml(result);
    const description = getDcDescription(xml);
    const title = getDcTitle(xml);

    expect(description).toBe('Daria Gusarova, Emmy Sharp');
    expect(title).toBe('Daria Gusarova, Emmy Sharp');
  });

  it('leaves dc:description unchanged if enter_caption_here is absent', async () => {
    const input = fs.readFileSync(noPlaceholderPath);
    const result = await writeAthleteNames(input, ['Emmy Sharp']);

    const xml = extractXmpXml(result);
    const description = getDcDescription(xml);
    const title = getDcTitle(xml);

    // dc:description should still have original value (not replaced)
    expect(description).toBe('Daria Gusarova');
    // dc:title should be updated to new name
    expect(title).toBe('Emmy Sharp');
  });
});
