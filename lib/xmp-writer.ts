import { DOMParser, XMLSerializer, Document, Element } from '@xmldom/xmldom';

const XMP_NAMESPACE = 'http://ns.adobe.com/xap/1.0/\0';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const IPTC_EXT_NS = 'http://iptc.org/std/Iptc4xmpExt/2008-02-29/';

/**
 * Writes athlete names into the XMP metadata of a JPEG buffer.
 *
 * - dc:description: replaces "enter_caption_here" in the rdf:li text if present; skips otherwise.
 * - dc:title: finds or creates rdf:li[@xml:lang="x-default"] and sets it to the athlete name string.
 *
 * The JPEG buffer is returned with the XMP segment updated in place (same byte length,
 * padded with spaces if the new XML is shorter, or segment rewritten if longer).
 *
 * @throws Error if no XMP APP1 segment is found in the buffer.
 */
export async function writeAthleteNames(
  jpgBuffer: Buffer,
  names: string[]
): Promise<Buffer> {
  const nameString = names.join(', ');

  // --- 1. Locate the XMP APP1 segment ---
  const marker = Buffer.from(XMP_NAMESPACE, 'binary');
  const markerIdx = findXmpMarker(jpgBuffer);
  if (markerIdx === -1) {
    throw new Error('XMP segment not found');
  }

  // APP1: FF E1 <2-byte-length> <namespace\0> <xml>
  const app1Start = markerIdx - 4;
  const segmentLength = jpgBuffer.readUInt16BE(app1Start + 2); // length field covers bytes after FF E1
  const xmlStart = markerIdx + Buffer.byteLength(XMP_NAMESPACE, 'binary');
  const segmentEnd = app1Start + 2 + segmentLength;

  const originalXml = jpgBuffer.subarray(xmlStart, segmentEnd).toString('utf8');

  // --- 2. Split xpacket wrapper from inner content ---
  const { packetBegin, innerXml, packetEnd } = splitXpacket(originalXml);

  // --- 3. Parse and modify inner XML ---
  const parser = new DOMParser();
  const doc = parser.parseFromString(innerXml, 'text/xml');

  updateDcDescription(doc, nameString);
  updateDcTitle(doc, nameString);
  updatePersonInImage(doc, names);

  // --- 4. Serialize back ---
  const serializer = new XMLSerializer();
  const newInnerXml = serializer.serializeToString(doc);

  // --- 5. Reassemble xpacket with same total byte length ---
  const newXml = reassembleXpacket(packetBegin, newInnerXml, packetEnd, originalXml.length);

  // --- 6. Rebuild the JPEG buffer ---
  return rebuildJpeg(jpgBuffer, app1Start, segmentEnd, xmlStart, newXml);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findXmpMarker(buf: Buffer): number {
  const ns = Buffer.from(XMP_NAMESPACE, 'binary');
  // Walk APP1 segments only (FF E1)
  let i = 2; // skip SOI (FF D8)
  while (i < buf.length - 4) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS

    const segLen = buf.readUInt16BE(i + 2);

    if (marker === 0xe1) {
      // Check if this APP1 contains the XMP namespace
      const nsCandidate = buf.subarray(i + 4, i + 4 + ns.length);
      if (nsCandidate.equals(ns)) {
        return i + 4; // offset of namespace start
      }
    }

    i += 2 + segLen;
  }
  // Fallback: plain search (handles non-standard segment ordering)
  const nsStr = 'http://ns.adobe.com/xap/1.0/\0';
  const idx = buf.indexOf(nsStr);
  return idx === -1 ? -1 : idx;
}

interface XpacketParts {
  packetBegin: string;
  innerXml: string;
  packetEnd: string;
}

function splitXpacket(xml: string): XpacketParts {
  // xpacket begin: <?xpacket begin="..." id="..."?>
  const beginMatch = xml.match(/^(<\?xpacket begin=[^?]*\?>)/);
  const endMatch = xml.match(/(<\?xpacket end="[rw]"\?>)\s*$/);

  const packetBegin = beginMatch ? beginMatch[1] : '';
  const packetEnd = endMatch ? endMatch[1] : '';

  let inner = xml;
  if (packetBegin) inner = inner.slice(packetBegin.length);
  if (packetEnd) {
    const endIdx = inner.lastIndexOf(packetEnd);
    if (endIdx !== -1) inner = inner.slice(0, endIdx);
  }

  return { packetBegin, innerXml: inner.trim(), packetEnd };
}

function reassembleXpacket(
  packetBegin: string,
  newInnerXml: string,
  packetEnd: string,
  targetByteLength: number
): string {
  // Build without padding to measure
  const base = packetBegin + '\n' + newInnerXml + '\n';
  const endStr = packetEnd;
  const needed = targetByteLength - Buffer.byteLength(base, 'utf8') - Buffer.byteLength(endStr, 'utf8');

  if (needed >= 0) {
    // Pad with spaces (standard XMP padding strategy)
    const padding = ' '.repeat(needed);
    return base + padding + endStr;
  } else {
    // New XML is larger — write without padding; segment will be resized in rebuildJpeg
    return base + endStr;
  }
}

function rebuildJpeg(
  buf: Buffer,
  app1Start: number,
  segmentEnd: number,
  xmlStart: number,
  newXml: string
): Buffer {
  const newXmlBuf = Buffer.from(newXml, 'utf8');
  const newSegmentContentLength = xmlStart - (app1Start + 4) + newXmlBuf.length; // namespace + new xml
  const newSegmentLength = newSegmentContentLength + 2; // +2 for the length field itself

  // APP1 header: FF E1 + 2-byte length
  const app1Header = Buffer.alloc(4);
  app1Header[0] = 0xff;
  app1Header[1] = 0xe1;
  app1Header.writeUInt16BE(newSegmentLength, 2);

  // Namespace bytes (between app1 header and xml content)
  const namespaceBuf = buf.subarray(app1Start + 4, xmlStart);

  return Buffer.concat([
    buf.subarray(0, app1Start),      // everything before APP1
    app1Header,                       // new APP1 marker + length
    namespaceBuf,                     // namespace identifier
    newXmlBuf,                        // new XML content
    buf.subarray(segmentEnd),         // everything after original APP1
  ]);
}

function updateDcDescription(doc: Document, nameString: string): void {
  const descriptions = doc.getElementsByTagNameNS(DC_NS, 'description');
  if (descriptions.length === 0) return;

  const descEl = descriptions[0];
  const alts = descEl.getElementsByTagNameNS(RDF_NS, 'Alt');
  if (alts.length === 0) return;

  const alt = alts[0];
  const items = alt.getElementsByTagNameNS(RDF_NS, 'li');

  for (let i = 0; i < items.length; i++) {
    const li = items[i];
    const text = li.textContent || '';
    if (text.includes('enter_caption_here')) {
      // Replace only the placeholder text
      while (li.firstChild) li.removeChild(li.firstChild);
      li.appendChild(doc.createTextNode(nameString));
      return;
    }
  }
  // "enter_caption_here" not found — leave dc:description unchanged per spec
}

/**
 * Writes athlete names to Iptc4xmpExt:PersonInImage — the field Photo Mechanic
 * labels "Personality". Each athlete gets a separate rdf:li in an rdf:Bag.
 * Replaces any existing PersonInImage value entirely.
 */
function updatePersonInImage(doc: Document, names: string[]): void {
  const rdfDescs = doc.getElementsByTagNameNS(RDF_NS, 'Description');
  if (rdfDescs.length === 0) return;
  const rdfDesc = rdfDescs[0];

  // Ensure the namespace is declared on the rdf:Description element
  if (!rdfDesc.getAttributeNS('http://www.w3.org/2000/xmlns/', 'Iptc4xmpExt')) {
    rdfDesc.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:Iptc4xmpExt', IPTC_EXT_NS);
  }

  // Remove existing PersonInImage if present
  const existing = doc.getElementsByTagNameNS(IPTC_EXT_NS, 'PersonInImage');
  for (let i = existing.length - 1; i >= 0; i--) {
    existing[i].parentNode?.removeChild(existing[i]);
  }

  // Build <Iptc4xmpExt:PersonInImage><rdf:Bag><rdf:li>Name</rdf:li>...</rdf:Bag></Iptc4xmpExt:PersonInImage>
  const personEl = doc.createElementNS(IPTC_EXT_NS, 'Iptc4xmpExt:PersonInImage');
  const bag = doc.createElementNS(RDF_NS, 'rdf:Bag');
  for (const name of names) {
    const li = doc.createElementNS(RDF_NS, 'rdf:li');
    li.appendChild(doc.createTextNode(name));
    bag.appendChild(li);
  }
  personEl.appendChild(bag);
  rdfDesc.appendChild(personEl);
}

function updateDcTitle(doc: Document, nameString: string): void {
  const titles = doc.getElementsByTagNameNS(DC_NS, 'title');

  if (titles.length > 0) {
    const titleEl = titles[0];
    let alt = titleEl.getElementsByTagNameNS(RDF_NS, 'Alt')[0];

    if (!alt) {
      alt = doc.createElementNS(RDF_NS, 'rdf:Alt');
      titleEl.appendChild(alt);
    }

    const items = alt.getElementsByTagNameNS(RDF_NS, 'li');
    let target: Element | null = null;

    for (let i = 0; i < items.length; i++) {
      const li = items[i];
      if (li.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang') === 'x-default') {
        target = li;
        break;
      }
    }

    if (!target) {
      target = doc.createElementNS(RDF_NS, 'rdf:li');
      target.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', 'x-default');
      alt.appendChild(target);
    }

    while (target.firstChild) target.removeChild(target.firstChild);
    target.appendChild(doc.createTextNode(nameString));
  } else {
    // dc:title doesn't exist — create it
    const rdfDescs = doc.getElementsByTagNameNS(RDF_NS, 'Description');
    if (rdfDescs.length === 0) return;

    const rdfDesc = rdfDescs[0];
    const titleEl = doc.createElementNS(DC_NS, 'dc:title');
    const alt = doc.createElementNS(RDF_NS, 'rdf:Alt');
    const li = doc.createElementNS(RDF_NS, 'rdf:li');
    li.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', 'x-default');
    li.appendChild(doc.createTextNode(nameString));
    alt.appendChild(li);
    titleEl.appendChild(alt);
    rdfDesc.appendChild(titleEl);
  }
}
