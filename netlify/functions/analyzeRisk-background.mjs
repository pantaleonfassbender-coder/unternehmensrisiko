import { GoogleGenAI } from '@google/genai';
import { getStore } from '@netlify/blobs';

// The risk analysis runs as a Netlify *background* function (the `-background`
// filename suffix). Gemini with Google Search grounding plus this large
// structured JSON output regularly runs past the 60s synchronous function
// limit, which surfaced to users as a 504 Gateway Timeout. Background functions
// may run for up to 15 minutes; the client receives an immediate 202 and then
// polls analyzeRiskStatus for the result, which we persist to Netlify Blobs.

// Strong consistency so the status poller reliably reads the latest write
// (a job that just finished, or an error) instead of a stale/empty value.
const jobStore = () => getStore({ name: 'risk-jobs', consistency: 'strong' });

// Pulls the first complete JSON object out of a raw model response, tolerating
// ```json code fences and any surrounding prose. Returns the parsed-and-
// re-serialized JSON string, or null if no valid object is found.
function extractJson(text) {
    if (!text) return null;

    // Strip a fenced code block if present.
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenceMatch ? fenceMatch[1] : text;

    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;

    const slice = candidate.slice(start, end + 1);
    try {
        return JSON.stringify(JSON.parse(slice));
    } catch {
        return null;
    }
}

// Collects the grounded web sources from a Gemini response and assigns each a
// stable 1-based number. Google Search grounding lists every consulted page in
// candidate.groundingMetadata.groundingChunks, each as { web: { uri, title } }.
// We de-duplicate by URI and return a numbered [{ id, title, uri }] list.
//
// IMPORTANT: grounding metadata is only populated for a *grounded* response,
// and in practice the chunk list comes back reliably only when the model emits
// prose. When the same grounded call is also forced to produce a large
// structured JSON, groundingChunks frequently returns empty — which is why the
// grounded research runs as its own prose step (see runAnalysis).
function extractSources(response) {
    const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const supports = response?.candidates?.[0]?.groundingMetadata?.groundingSupports ?? [];
    const supportedChunkIndices = new Set(
        supports.flatMap(support => support?.groundingChunkIndices ?? [])
    );
    const relevantChunks = supportedChunkIndices.size
        ? chunks.filter((_, index) => supportedChunkIndices.has(index))
        : chunks;
    const seen = new Map();
    const sources = [];

    for (const chunk of relevantChunks) {
        const uri = chunk?.web?.uri;
        if (!uri || seen.has(uri)) continue;
        const id = sources.length + 1;
        seen.set(uri, id);
        sources.push({
            id,
            title: chunk.web.title || uri,
            uri
        });
    }

    return sources;
}

const EMPLOYER_PLATFORM_HOSTS = [
    /(^|\.)kununu\.[a-z.]+$/,
    /(^|\.)glassdoor\.[a-z.]+$/
];

const COMPANY_NAME_STOP_WORDS = new Set([
    'ag', 'co', 'gbr', 'gmbh', 'kg', 'kgaa', 'limited', 'llc', 'ltd', 'mbh',
    'ohg', 'plc', 'se', 'ug', 'und'
]);

function normalizeIdentityText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ß/g, 'ss')
        .toLowerCase()
        .replace(/&/g, ' und ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function companyIdentityTokens(company) {
    return normalizeIdentityText(company)
        .split(/\s+/)
        .filter(token => token.length >= 2 && !COMPANY_NAME_STOP_WORDS.has(token));
}

function parseUrl(value) {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

function employerPlatformHost(url) {
    return Boolean(url && EMPLOYER_PLATFORM_HOSTS.some(pattern => pattern.test(url.hostname)));
}

export function isEmployerPlatformSource(source) {
    const url = parseUrl(source?.uri);
    const label = normalizeIdentityText(`${source?.title || ''} ${source?.uri || ''}`);
    return employerPlatformHost(url) || /\b(kununu|glassdoor)\b/.test(label);
}

export function employerProfileMatchesCompany(source, company) {
    const url = parseUrl(source?.uri);
    if (!employerPlatformHost(url)) return false;

    const tokens = companyIdentityTokens(company);
    if (!tokens.length) return false;

    let pathname = url.pathname;
    try {
        pathname = decodeURIComponent(pathname);
    } catch {
        return false;
    }

    // Liberalized match: employer-platform slugs often abbreviate or run the
    // company name together (e.g. "deutsche-bank" or "deutschebank"), so we no
    // longer require every name token to appear as its own path segment. We
    // still require that every significant token is *present* — matched as a
    // substring of the collapsed (space-free) path — which keeps namesakes out
    // (a bare "geiger" profile still fails for "Geiger Edelmetalle") while
    // letting legitimate concatenated or abbreviated slugs through.
    const collapsedPath = normalizeIdentityText(pathname).replace(/\s+/g, '');
    return tokens.every(token => collapsedPath.includes(token));
}

async function validateEmployerPlatformSource(source, company, fetchImpl) {
    // Employer platforms (Kununu, Glassdoor) aggressively block automated
    // requests with challenges, redirects and slow responses. A failed liveness
    // check therefore no longer discards the profile outright: if the *original*
    // URL is itself a matching platform profile we keep it, accepting that the
    // liveness could not be confirmed. The intro asks users to verify these
    // profiles manually.
    let response;
    try {
        response = await fetchImpl(source.uri, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(12000)
        });
    } catch {
        return employerProfileMatchesCompany(source, company) ? source : null;
    }

    // Only a clear "gone" signal disqualifies a profile. Bot-protection codes
    // (401/403/429) are treated as "could not verify", not as rejection.
    if ([404, 410].includes(response.status) || response.status >= 500) return null;

    // Prefer the resolved (post-redirect) URL, but if a redirect landed on a
    // login/challenge page that no longer matches, fall back to the original
    // profile URL before giving up.
    const resolvedSource = {
        ...source,
        uri: response.url || source.uri
    };
    if (employerProfileMatchesCompany(resolvedSource, company)) return resolvedSource;
    return employerProfileMatchesCompany(source, company) ? source : null;
}

export async function validateEmployerPlatformSources(sources, company, fetchImpl = fetch) {
    const validated = await Promise.all((sources ?? []).map(async source => {
        if (!isEmployerPlatformSource(source)) return source;
        return validateEmployerPlatformSource(source, company, fetchImpl);
    }));

    return validated.filter(Boolean);
}

export function mergeResearchResults(results) {
    const sources = [];
    const seenUris = new Set();

    for (const result of results) {
        for (const source of result.sources ?? []) {
            if (!source?.uri || seenUris.has(source.uri)) continue;
            seenUris.add(source.uri);
            sources.push({
                id: sources.length + 1,
                title: source.title || source.uri,
                uri: source.uri
            });
        }
    }

    return {
        brief: results
            .map(result => `${result.heading}\n${result.brief || 'Keine belastbaren Treffer gefunden.'}`)
            .join('\n\n'),
        sources
    };
}

export function isSuspiciousLinearSeries(series) {
    if (!Array.isArray(series) || series.length !== 12) return true;
    if (!series.every(value => Number.isFinite(value) && value >= 0 && value <= 100)) return true;

    const deltas = series.slice(1).map((value, index) => value - series[index]);
    const averageDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    const maxDeltaDeviation = Math.max(...deltas.map(value => Math.abs(value - averageDelta)));
    const range = Math.max(...series) - Math.min(...series);

    return range >= 8 && maxDeltaDeviation <= 1;
}

export function normalizeMeasuredTrends(trends, sources, brief = '') {
    const sourceIds = new Set(sources.map(source => source.id));
    if (!Array.isArray(trends)) return [];

    return trends.filter(trend => {
        if (!trend || trend.basis !== 'measured') return false;
        if (!Array.isArray(trend.sourceIds) || !trend.sourceIds.some(id => sourceIds.has(id))) return false;
        if (typeof trend.evidenceQuote !== 'string' || !trend.evidenceQuote.trim()) return false;
        if (!brief.includes(trend.evidenceQuote)) return false;
        const quotedValues = trend.evidenceQuote.match(/\b(?:100|[1-9]?\d)\b/g)?.map(Number) ?? [];
        if (quotedValues.length !== 12 || quotedValues.some((value, index) => value !== trend.series?.[index])) return false;
        return !isSuspiciousLinearSeries(trend.series);
    }).map(trend => ({
        term: String(trend.term || '').trim(),
        momentum: ['steigend', 'stabil', 'fallend'].includes(trend.momentum) ? trend.momentum : 'stabil',
        series: trend.series.map(value => Math.round(value)),
        basis: 'measured',
        sourceIds: trend.sourceIds.filter(id => sourceIds.has(id))
    })).filter(trend => trend.term);
}

// Builds the "cited in text" reference list from the numbered grounded sources.
// The structuring step cites claims with inline [n] markers whose numbers refer
// to the source list we hand it; here we scan every text field for those
// markers and return exactly the sources that were actually cited, so each [n]
// in the rendered analysis resolves to a real, clickable grounded page. This is
// authoritative (server-derived) rather than trusting the model to repeat URLs.
function buildReferences(analysis, sources) {
    const byId = new Map(sources.map(s => [s.id, s]));
    const used = new Set();

    const scan = (value) => {
        if (typeof value === 'string') {
            const re = /\[([\d\s,;]+)\]/g;
            let m;
            while ((m = re.exec(value)) !== null) {
                for (const part of m[1].split(/[\s,;]+/)) {
                    const id = Number(part);
                    if (byId.has(id)) used.add(id);
                }
            }
        } else if (Array.isArray(value)) {
            value.forEach(scan);
        } else if (value && typeof value === 'object') {
            Object.values(value).forEach(scan);
        }
    };

    // Only the human-readable analysis fields carry citations.
    scan(analysis.identity);
    scan(analysis.trends);
    scan(analysis.risks);
    scan(analysis.swot);
    scan(analysis.summary);

    for (const trend of analysis.trends ?? []) {
        for (const id of trend.sourceIds ?? []) {
            if (byId.has(id)) used.add(id);
        }
    }

    return [...used]
        .sort((a, b) => a - b)
        .map(id => {
            const s = byId.get(id);
            return { id: s.id, title: s.title, url: s.uri };
        });
}

// STEP 1 — Grounded research. Runs Google Search grounding and asks for a
// factual prose brief (no JSON). Prose output is what makes the grounding
// metadata — the consulted pages — come back reliably, and a search-focused
// prompt actually surfaces concrete incidents (thefts, trials, protests) that
// the schema-filling prompt used to miss.
async function researchCompany(ai, company) {
    const systemInstruction = `Du bist ein investigativer Risikoanalyst für Unternehmenssicherheit. Du nutzt aktiv die Google-Suche (Grounding), um belastbare, konkrete Fakten über genau ein Unternehmen zu recherchieren. Die eindeutige Unternehmensidentität hat Vorrang vor Vollständigkeit. Du erfindest nichts, vermischst keine namensähnlichen Organisationen und schreibst nur, was du in den Suchergebnissen findest. Sprache: Deutsch.`;

    const prompt = `Recherchiere das Unternehmen "${company}" gründlich per Google-Suche und erstelle ein sachliches Rechercheprotokoll (Fließtext, KEIN JSON).

VERBINDLICHE IDENTITÄTSPRÜFUNG VOR DER INHALTLICHEN RECHERCHE:
1. Ermittle zuerst die exakte juristische/öffentliche Identität des Zielunternehmens: vollständiger Name inklusive Rechtsform, Hauptsitz/Adresse, Branche, offizielle Website/Domain sowie belegte Marken- oder Konzernzugehörigkeiten.
2. Lege diese Merkmale am Anfang unter der Überschrift "IDENTITÄTSPRÜFUNG" offen. Wenn die Eingabe mehrdeutig bleibt, benenne die Mehrdeutigkeit ausdrücklich und übernimm keine unsicheren Treffer.
3. Ordne einen Treffer nur dann zu, wenn neben einer Namensähnlichkeit mindestens ein belastbarer Identifikator übereinstimmt, etwa Rechtsform, offizielle Domain, Standort/Adresse, Branche, Marke oder Konzernzugehörigkeit.
4. Unternehmen mit abweichender Branche, Adresse oder Domain sind Namensvetter und strikt auszuschließen. Beispiel: Ergebnisse zu einer "Geiger GmbH" dürfen nicht der "Geiger Edelmetalle AG" zugerechnet werden, sofern keine belegte organisatorische Identität oder Zugehörigkeit besteht.
5. WICHTIG – Rechtsform ist KEIN alleiniges Ausschlusskriterium: Eine abweichende Rechtsform allein (z.B. AG statt GmbH, SE, Holding) trennt kein Unternehmen, wenn Markenname, Standort/Adresse und Branche übereinstimmen. Dasselbe Unternehmen erscheint durch Umfirmierung, Umwandlung, Konzernstruktur oder ungenaue Eingabe häufig unter mehreren Rechtsformen. Behandle "${company}" und namensgleiche Treffer am selben Sitz bzw. mit derselben Marke/Branche als DIESELBE Zielidentität, auch wenn die Rechtsform abweicht, und weise dies in der Identitätsprüfung aus.
6. Für Kununu, Glassdoor und andere Arbeitgeberplattformen gilt ein liberaler, aber transparenter Maßstab: Verwende ein Profil, wenn der Unternehmensname übereinstimmt und möglichst ein weiterer Identifikator dazu passt. Ist die Zuordnung nicht vollständig gesichert, schließe das Profil nicht aus, sondern übernimm es MIT einem ausdrücklichen Hinweis, dass die Zuordnung dieses Arbeitgeberprofils noch überprüft werden sollte.
7. Wenn sich für einen Themenbereich keine eindeutig zuordenbaren Belege finden, schreibe ausdrücklich "keine eindeutig zuordenbaren Belege gefunden" statt Treffer eines Namensvetters zu verwenden.

Suche gezielt und benenne konkrete Ereignisse mit Datum, Ort und Beteiligten:
- Kriminalität GEGEN das Unternehmen: Einbrüche, Diebstähle, Raubüberfälle, Überfälle auf Standorte/Lager/Tresore/Filialen, Vandalismus. Auch Vorfälle, die mehrere Jahre zurückliegen (z.B. 2022–2026), sind relevant, ebenso spätere Gerichtsprozesse und Urteile dazu.
- Wirtschafts-/Unternehmenskriminalität: Betrug, Korruption, Geldwäsche, Ermittlungen, Strafprozesse, Urteile.
- Reputation und Kontroversen in Presse und Öffentlichkeit.
- Proteste, Aktivismus, politischer bzw. extremistischer Bezug.
- Geopolitische Abhängigkeiten und Standortrisiken.
- Mitarbeiterstimmen auf Kununu und Glassdoor (Arbeitsklima, Kritikpunkte).
- Aktuelle Nachrichten und dominierende Themen der letzten 12 Monate.

Nenne für jedes wichtige Faktum die Quelle. Sei vollständig und präzise, aber nimm nur Fakten auf, deren Zuordnung zur geprüften Zielidentität belastbar ist. Führe am Ende unter "AUSGESCHLOSSENE NAMENSVETTER" kurz auf, welche ähnlich benannten Unternehmen oder Arbeitgeberprofile du bewusst nicht verwendet hast und warum.`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            systemInstruction,
            tools: [{ googleSearch: {} }],
        }
    });

    return {
        heading: 'ALLGEMEINE UNTERNEHMENSRECHERCHE',
        brief: response.text ?? '',
        sources: extractSources(response)
    };
}

async function researchPhysicalIncidents(ai, company) {
    const systemInstruction = `Du bist ein investigativer Rechercheur für physische Unternehmenssicherheit. Du nutzt Google Search Grounding und suchst gezielt nach Einbrüchen, Diebstählen, Raubtaten sowie späteren Strafprozessen und Urteilen. Du prüfst die Unternehmensidentität über Rechtsform, offizielle Domain, Standort, Adresse, Marke und Konzernzugehörigkeit. Sprache: Deutsch.`;

    const prompt = `Recherchiere gezielt physische Sicherheitsvorfälle gegen "${company}" und erstelle ein kurzes Faktenprotokoll (KEIN JSON).

Gehe in dieser Reihenfolge vor:
1. Ermittle offizielle Standorte, Niederlassungen, markante Gebäude (z.B. Stammhaus, Schloss, Firmenzentrale), betriebene Tresor-/Schließfachanlagen, Marken und Konzernzugehörigkeiten des Zielunternehmens. Notiere die Eigennamen dieser Orte – gerade markante Gebäudenamen sind oft der einzige Anker in der Berichterstattung.
2. Suche für den Zeitraum 2022 bis heute nach Kombinationen aus Firmenname, den unter 1. ermittelten Orts-/Gebäudenamen und Begriffen wie Einbruch, Diebstahl, Raub, Tresor, Schließfach, Bankschließfach, Edelmetalle, Beute, Anklage, Landgericht, Strafprozess, Prozessbeginn, Prozessauftakt, Urteil und Revision.
3. Suche zusätzlich nach Berichten, die nur den Tatort, ein Gebäude oder eine Unternehmensbeschreibung nennen, ohne den Firmennamen (oder mit abweichender Rechtsform) zu erwähnen. Ein Einbruch, Diebstahl oder Raub an einer eindeutig dem Zielunternehmen zuzuordnenden Betriebsstätte (Stammhaus, Zentrale, markantes Gebäude, betriebene Tresor-/Schließfachanlage) ist ein Sicherheitsvorfall GEGEN das Zielunternehmen – auch dann, wenn direkt betroffene Beute Kunden gehörte (z.B. ausgeräumte Kundenschließfächer) oder wenn in der Meldung eine andere Rechtsform des Unternehmens steht. Lege die Identitätskette vom Tatort zum Unternehmen offen.
4. Prüfe ausdrücklich, ob ein älterer Vorfall später Gegenstand eines prominenten Strafprozesses wurde. Trenne Tatdatum, Prozessbeginn und Urteil sauber und halte fest, wenn ein Prozess aktuell (in den letzten zwölf Monaten) läuft.
5. Nenne zu jedem belastbaren Treffer Datum, Ort, Tatvorwurf, Verfahrensstand, zuständiges Gericht und Quelle. Wenn nichts eindeutig zuordenbar ist, sage dies ausdrücklich.

Verwechsle das Zielunternehmen nicht mit branchen- oder ortsfremden, nur namensähnlichen Unternehmen. Eine abweichende Rechtsform allein (AG statt GmbH o.ä.) ist bei übereinstimmender Marke, Branche und Adresse KEIN Ausschlussgrund. Erfinde keine Verbindung, Daten oder Verfahrensstände.`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            systemInstruction,
            tools: [{ googleSearch: {} }],
        }
    });

    return {
        heading: 'VERTIEFTE VORFALLS- UND PROZESSRECHERCHE',
        brief: response.text ?? '',
        sources: extractSources(response)
    };
}

// STEP 2 — Structuring. No grounding tool here, so we can request strict JSON
// via responseMimeType and parse it reliably. The model condenses the research
// brief into the app's schema and cites claims with [n] markers that map to the
// numbered source list handed in below.
async function structureAnalysis(ai, company, brief, sources) {
    const sourceList = sources.length
        ? sources.map(s => `[${s.id}] ${s.title} — ${s.uri}`).join('\n')
        : '(keine Quellen gefunden)';

    const systemInstruction = `Du bist ein Risikoanalyst. Du strukturierst ein vorliegendes Rechercheprotokoll in ein festes JSON-Format. Du stützt dich AUSSCHLIESSLICH auf das Protokoll und die nummerierte Quellenliste – du erfindest keine neuen Fakten und keine neuen Quellen. Sprache: Deutsch.

Antworte NUR mit einem JSON-Objekt in exakt dieser Struktur:
{
  "identity": {
    "name": "Eindeutig geprüfter Unternehmensname inklusive Rechtsform",
    "headquarters": "Sitz/Adresse oder 'nicht eindeutig belegt'",
    "website": "Offizielle Domain oder 'nicht eindeutig belegt'",
    "industry": "Branche oder 'nicht eindeutig belegt'",
    "verification": "Kurze Begründung der Identitätszuordnung mit [n]-Belegen und ggf. Hinweis auf ausgeschlossene Namensvetter"
  },
  "keywords": ["Stichwort1", ...],            // Exakt 10 relevante Stichworte (Top-Themen)
  "trendStatus": "measured|unavailable",
  "trendNote": "Kurzer Hinweis zur Datenbasis",
  "trends": [
    // Nur tatsächlich gemessene, im Rechercheprotokoll belegte Google-Trends-Monatswerte.
    { "term": "Thema", "momentum": "steigend|stabil|fallend", "series": [0-100, ... genau 12 Werte], "basis": "measured", "sourceIds": [1], "evidenceQuote": "Wörtlicher Ausschnitt aus dem Protokoll, der exakt diese 12 Werte enthält" }
  ],
  "risks": {
    "geopolitics": { "score": 0-10, "reason": "Kurze Begründung (max 2 Sätze)" },
    "reputation": { "score": 0-10, "reason": "Kurze Begründung" },
    "crime":      { "score": 0-10, "reason": "Unternehmens-/Wirtschaftskriminalität (Betrug, Korruption, Geldwäsche)" },
    "burglary":   { "score": 0-10, "reason": "Kriminalität & Einbruch GEGEN das Unternehmen: Einbrüche, Diebstahl, Raub, Vandalismus, Angriffe auf Standorte/Lager sowie die physische Sicherheitslage" },
    "protests":   { "score": 0-10, "reason": "Kurze Begründung" },
    "terrorism":  { "score": 0-10, "reason": "Kurze Begründung (Links-/Rechtsextremismus-Bezug)" },
    "insider":    { "score": 0-10, "reason": "Kurze Begründung basierend auf Kununu/Glassdoor (z.B. toxisches Klima, Burnout)" }
  },
  "swot": {
    "strengths":     ["..."],   // 2-3 Punkte
    "weaknesses":    ["..."],   // 2-3 Punkte
    "opportunities": ["..."],   // 2-3 Punkte
    "threats":       ["..."]    // 2-3 Punkte
  },
  "summary": "Abschließendes Gesamturteil zur Risikoposition (ca. 3 Sätze)."
}

REGELN:
- Die Scores gehen von 0 (kein Risiko) bis 10 (sehr hohes, existenzbedrohendes Risiko).
- Alle Inhalte müssen sich auf die unter "identity" ausgewiesene Zielidentität beziehen. Übernimm keinerlei Aussage zu einem nur ähnlich benannten Unternehmen.
- Rechtsform, Domain, Sitz, Branche, Marke und Konzernzugehörigkeit sind Identitätsmerkmale. Ein ähnlicher Name allein ist kein Beleg.
- Eine abweichende Rechtsform ALLEIN (z.B. AG statt GmbH, SE, Holding) trennt kein Unternehmen: Stimmen Markenname, Sitz/Adresse und Branche überein, handelt es sich um dieselbe Zielidentität (Umfirmierung/Umwandlung/Konzernstruktur/ungenaue Eingabe). Verwirf einen sonst eindeutig zuordenbaren Vorfall NICHT nur deshalb, weil die Quelle eine andere Rechtsform des Unternehmens nennt.
- Arbeitgeberbewertungen (Kununu/Glassdoor) dürfen in "insider" einfließen, wenn das Rechercheprotokoll ihre Zuordnung zur Zielidentität plausibel macht (übereinstimmender Firmenname und möglichst ein weiterer Anhaltspunkt). Ist die Zuordnung unsicher, setze den Score nicht pauschal auf 0, sondern gib eine vorsichtige Einschätzung und weise im "reason" ausdrücklich darauf hin, dass die zugrunde liegenden Arbeitgeberprofile vor einer Verwendung überprüft werden sollten. Verwende keine Quelle eines eindeutig ausgeschlossenen Namensvetters.
- Wenn das Protokoll einen Treffer als Namensvetter, mehrdeutig oder ausgeschlossen kennzeichnet, darf dieser Treffer in keinem Feld, Stichwort, Trend, SWOT-Punkt oder Gesamturteil erscheinen.
- Wenn im Protokoll ein konkreter Einbruch/Diebstahl/Raub oder ein Strafprozess gegen das Unternehmen auftaucht, MUSS er im passenden Feld ("burglary" bzw. "crime") mit Datum/Ort konkret benannt werden.
- Ein Einbruch, Diebstahl oder Raub an einer eindeutig dem Zielunternehmen zuzuordnenden Betriebsstätte (Stammhaus, Zentrale, markantes Gebäude, betriebene Tresor-/Schließfachanlage) zählt als Vorfall GEGEN das Unternehmen und MUSS in "burglary" abgebildet werden – auch dann, wenn die direkt erbeuteten Werte Kunden gehörten (z.B. ausgeräumte Kundenschließfächer) oder die Quelle nur den Tatort/das Gebäude nennt. Ein solcher belegter Vorfall darf NICHT mit Score 0 bewertet werden; setze einen der Schwere und Aktualität angemessenen, deutlich erhöhten Score und begründe ihn.
- Ein Strafprozess gegen mutmaßliche Täter eines Einbruchs oder Diebstahls GEGEN das Unternehmen gehört zwingend zu "burglary", nicht zu "crime". Liegt der Prozess in den letzten zwölf Monaten, nenne neben Tatdatum und Tatort auch den konkreten Prozessbeginn und das zuständige Gericht.
- Google-Trends-Werte dürfen NIEMALS geschätzt, geglättet, interpoliert oder aus allgemeiner Nachrichtenlage abgeleitet werden. Übernimm eine Zeitreihe nur, wenn das Protokoll zwölf konkrete monatliche Messwerte und eine passende Quelle enthält. Andernfalls setze "trends" auf [], "trendStatus" auf "unavailable" und erkläre in "trendNote", dass keine belastbare Zeitreihe vorlag.
- Eine nahezu lineare Zahlenfolge ist kein zulässiger Ersatz für Messdaten. "sourceIds" muss mindestens eine tatsächlich passende Nummer aus der Quellenliste enthalten. "evidenceQuote" muss ein wörtlich kopierter Protokollausschnitt sein, der exakt die zwölf Werte aus "series" in derselben Reihenfolge enthält.
- ZITIERWEISE (SEHR WICHTIG): Belege konkrete Aussagen in "reason", "summary" und den SWOT-Punkten mit nummerierten Verweisen in eckigen Klammern, z.B. [1] oder [1, 3]. Verwende AUSSCHLIESSLICH Nummern aus der unten stehenden Quellenliste. Erfinde keine Nummern und keine URLs.`;

    const prompt = `Unternehmen: "${company}".

Nummerierte Quellenliste (nutze diese Nummern für [n]-Verweise):
${sourceList}

Rechercheprotokoll:
"""
${brief}
"""

Erstelle daraus das JSON gemäß Schema und belege die Aussagen mit [n]-Verweisen aus der Quellenliste.`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            systemInstruction,
            responseMimeType: 'application/json',
        }
    });

    const rawText = response.text ?? '';
    const jsonText = extractJson(rawText);
    if (!jsonText) {
        const err = new Error('Es konnte keine gültige Analyse aus der KI-Antwort extrahiert werden.');
        err.code = 'INVALID_AI_RESPONSE';
        throw err;
    }
    return JSON.parse(jsonText);
}

async function runAnalysis(company) {
    // Initialize Gemini API. Credentials are injected by the Netlify AI Gateway
    // into the modern (v2) function runtime — no API key needed.
    const ai = new GoogleGenAI({});

    // Step 1: broad company research plus a separate incident-focused search.
    // The second search deliberately follows locations and court terminology,
    // because crime reporting often omits the company's exact legal name.
    const researchResults = await Promise.all([
        researchCompany(ai, company),
        researchPhysicalIncidents(ai, company)
    ]);
    const validatedResearchResults = await Promise.all(researchResults.map(async result => ({
        ...result,
        sources: await validateEmployerPlatformSources(result.sources, company)
    })));
    const research = mergeResearchResults(validatedResearchResults);
    const { brief, sources } = research;

    // Step 2: structure the brief into the app schema (no grounding, strict JSON).
    const analysis = await structureAnalysis(ai, company, brief, sources);
    analysis.trends = normalizeMeasuredTrends(analysis.trends, sources, brief);
    if (!analysis.trends.length) {
        analysis.trendStatus = 'unavailable';
        analysis.trendNote = 'Keine belastbare Google-Trends-Zeitreihe mit zwölf gemessenen Monatswerten gefunden; es werden bewusst keine Werte geschätzt.';
    }

    // Grounding supports narrow the list to pages that support emitted text.
    // Those pages become the "Belegte Quellen" list, and the numbered
    // references (the [n] targets cited in the text) are derived from them so
    // every citation resolves to a real, clickable source.
    analysis.sources = sources.map(s => ({ title: s.title, uri: s.uri }));
    analysis.references = buildReferences(analysis, sources);

    return analysis;
}

export default async (req) => {
    // Background functions always answer the client with 202; the browser then
    // polls analyzeRiskStatus. We still parse the payload to learn the jobId.
    let jobId;
    let company;
    try {
        const body = await req.json();
        jobId = body.jobId;
        company = body.company;
    } catch {
        return; // Malformed request; nothing we can persist without a jobId.
    }

    if (!jobId || !company) return;

    const store = jobStore();

    // Mark the job as running so the poller can distinguish "in progress" from
    // "unknown job" and so we have a record even if the analysis crashes.
    await store.setJSON(jobId, { status: 'processing', company, startedAt: Date.now() });

    try {
        const result = await runAnalysis(company);
        await store.setJSON(jobId, { status: 'done', company, result, finishedAt: Date.now() });
    } catch (error) {
        console.error('Error running risk analysis:', error);
        await store.setJSON(jobId, {
            status: 'error',
            company,
            code: error?.code || 'INTERNAL_ERROR',
            message: error?.message || 'Unbekannter Fehler bei der Analyse.',
            finishedAt: Date.now()
        });
    }
};
