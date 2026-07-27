import { getStore } from '@netlify/blobs';

// Poll endpoint for the risk analysis. The browser triggers the long-running
// analyzeRisk-background function and then polls here with the same jobId until
// the analysis is done or has failed. This keeps every request well within the
// synchronous function limit, avoiding the 504 Gateway Timeout that the
// blocking single-request design produced.

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

// Strong consistency so we never report "still processing" after the
// background function has already written the finished result.
const jobStore = () => getStore({ name: 'risk-jobs', consistency: 'strong' });

export default async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('', { status: 200, headers: corsHeaders });
    }

    const jobId = new URL(req.url).searchParams.get('jobId');
    if (!jobId) {
        return Response.json({ error: 'jobId required' }, { status: 400, headers: corsHeaders });
    }

    const record = await jobStore().get(jobId, { type: 'json' });

    // No record yet: the background function may not have started writing. Treat
    // as still processing so the client keeps polling (it enforces its own
    // overall timeout).
    if (!record) {
        return Response.json({ status: 'processing' }, { status: 200, headers: corsHeaders });
    }

    if (record.status === 'done') {
        return Response.json({ status: 'done', result: record.result }, { status: 200, headers: corsHeaders });
    }

    if (record.status === 'error') {
        return Response.json(
            { status: 'error', message: record.message || 'Fehler bei der Analyse.' },
            { status: 200, headers: corsHeaders }
        );
    }

    return Response.json({ status: 'processing' }, { status: 200, headers: corsHeaders });
};
