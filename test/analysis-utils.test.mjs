import test from 'node:test';
import assert from 'node:assert/strict';

import {
    employerProfileMatchesCompany,
    isSuspiciousLinearSeries,
    mergeResearchResults,
    normalizeMeasuredTrends,
    validateEmployerPlatformSources
} from '../netlify/functions/analyzeRisk-background.mjs';

test('mergeResearchResults deduplicates and renumbers grounded sources', () => {
    const merged = mergeResearchResults([
        {
            heading: 'A',
            brief: 'Erster Bericht',
            sources: [{ id: 1, title: 'Quelle A', uri: 'https://example.com/a' }]
        },
        {
            heading: 'B',
            brief: 'Zweiter Bericht',
            sources: [
                { id: 1, title: 'Quelle A doppelt', uri: 'https://example.com/a' },
                { id: 2, title: 'Quelle B', uri: 'https://example.com/b' }
            ]
        }
    ]);

    assert.match(merged.brief, /A\nErster Bericht/);
    assert.match(merged.brief, /B\nZweiter Bericht/);
    assert.deepEqual(merged.sources, [
        { id: 1, title: 'Quelle A', uri: 'https://example.com/a' },
        { id: 2, title: 'Quelle B', uri: 'https://example.com/b' }
    ]);
});

test('employerProfileMatchesCompany distinguishes Geiger Edelmetalle from Geiger GmbH', () => {
    assert.equal(employerProfileMatchesCompany({
        title: 'Geiger Edelmetalle Erfahrungen: 42 Bewertungen',
        uri: 'https://www.kununu.com/de/geiger-edelmetalle'
    }, 'Geiger Edelmetalle GmbH'), true);

    assert.equal(employerProfileMatchesCompany({
        title: 'Geiger Edelmetalle GmbH Erfahrungen: 120 Bewertungen',
        uri: 'https://www.kununu.com/de/geiger'
    }, 'Geiger Edelmetalle GmbH'), false);
});

test('employerProfileMatchesCompany accepts concatenated/abbreviated slugs', () => {
    // Liberalized matching: slugs that run the name together must still match.
    assert.equal(employerProfileMatchesCompany({
        title: 'Deutsche Bank Erfahrungen',
        uri: 'https://www.kununu.com/de/deutschebank'
    }, 'Deutsche Bank AG'), true);

    // Regional Kununu domains are recognized as employer platforms too.
    assert.equal(employerProfileMatchesCompany({
        title: 'Muster GmbH auf kununu',
        uri: 'https://www.kununu.com/at/muster'
    }, 'Muster GmbH'), true);
});

test('validateEmployerPlatformSources keeps a matching profile when the live check fails', async () => {
    // Bot protection frequently makes the fetch throw or time out; a real
    // matching profile URL must survive instead of being silently dropped.
    const sources = [
        { id: 1, title: 'Geiger Edelmetalle auf kununu', uri: 'https://www.kununu.com/de/geiger-edelmetalle' }
    ];
    const fetchImpl = async () => {
        throw new Error('bot challenge / timeout');
    };

    assert.deepEqual(await validateEmployerPlatformSources(
        sources,
        'Geiger Edelmetalle GmbH',
        fetchImpl
    ), sources);
});

test('validateEmployerPlatformSources resolves redirects and rejects mismatched or dead profiles', async () => {
    const sources = [
        { id: 1, title: 'Offizielle Website', uri: 'https://example.com' },
        { id: 2, title: 'Geiger Edelmetalle auf kununu', uri: 'https://grounding.test/correct' },
        { id: 3, title: 'Geiger GmbH auf kununu', uri: 'https://grounding.test/wrong' },
        { id: 4, title: 'Geiger Edelmetalle auf kununu', uri: 'https://grounding.test/dead' }
    ];
    const fetchImpl = async uri => {
        if (uri.endsWith('/correct')) {
            return { status: 403, url: 'https://www.kununu.com/de/geiger-edelmetalle' };
        }
        if (uri.endsWith('/wrong')) {
            return { status: 200, url: 'https://www.kununu.com/de/geiger' };
        }
        return { status: 404, url: 'https://www.kununu.com/de/geiger-edelmetalle-alt' };
    };

    assert.deepEqual(await validateEmployerPlatformSources(
        sources,
        'Geiger Edelmetalle GmbH',
        fetchImpl
    ), [
        { id: 1, title: 'Offizielle Website', uri: 'https://example.com' },
        {
            id: 2,
            title: 'Geiger Edelmetalle auf kununu',
            uri: 'https://www.kununu.com/de/geiger-edelmetalle'
        }
    ]);
});

test('isSuspiciousLinearSeries rejects interpolated-looking values', () => {
    assert.equal(isSuspiciousLinearSeries([10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65]), true);
    assert.equal(isSuspiciousLinearSeries([12, 18, 11, 40, 24, 22, 75, 31, 27, 58, 34, 29]), false);
});

test('normalizeMeasuredTrends keeps only sourced measured non-linear series', () => {
    const sources = [{ id: 1, title: 'Trends', uri: 'https://example.com/trends' }];
    const trends = normalizeMeasuredTrends([
        {
            term: 'belegt',
            momentum: 'steigend',
            basis: 'measured',
            sourceIds: [1],
            evidenceQuote: '12, 18, 11, 40, 24, 22, 75, 31, 27, 58, 34, 29',
            series: [12, 18, 11, 40, 24, 22, 75, 31, 27, 58, 34, 29]
        },
        {
            term: 'linear',
            momentum: 'steigend',
            basis: 'measured',
            sourceIds: [1],
            evidenceQuote: '10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65',
            series: [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65]
        },
        {
            term: 'geschätzt',
            momentum: 'stabil',
            basis: 'estimated',
            sourceIds: [1],
            evidenceQuote: '12, 18, 11, 40, 24, 22, 75, 31, 27, 58, 34, 29',
            series: [12, 18, 11, 40, 24, 22, 75, 31, 27, 58, 34, 29]
        }
    ], sources, 'Gemessene Monatswerte: 12, 18, 11, 40, 24, 22, 75, 31, 27, 58, 34, 29. Lineare Testwerte: 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65.');

    assert.equal(trends.length, 1);
    assert.equal(trends[0].term, 'belegt');
});

test('normalizeMeasuredTrends rejects a series not quoted in the grounded brief', () => {
    const trends = normalizeMeasuredTrends([{
        term: 'unbelegt',
        momentum: 'stabil',
        basis: 'measured',
        sourceIds: [1],
        evidenceQuote: '12, 18, 11, 40, 24, 22, 75, 31, 27, 58, 34, 29',
        series: [12, 18, 11, 40, 24, 22, 75, 31, 27, 58, 34, 29]
    }], [{ id: 1 }], 'Im Protokoll stehen keine Monatswerte.');

    assert.deepEqual(trends, []);
});
