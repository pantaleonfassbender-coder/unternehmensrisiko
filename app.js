document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('search-form');
    const input = document.getElementById('company-input');
    const analyzeBtn = document.getElementById('analyze-btn');
    const btnText = analyzeBtn.querySelector('.btn-text');
    const spinner = analyzeBtn.querySelector('.spinner');
    
    const loadingState = document.getElementById('loading-state');
    const statusText = document.getElementById('status-text');
    const resultsContainer = document.getElementById('results-container');
    const introSection = document.getElementById('intro-section');

    // DOM Elements for Results
    const keywordsContainer = document.getElementById('keywords-container');
    const aiSummary = document.getElementById('ai-summary');

    // Escapes HTML so model-provided text can be safely injected as innerHTML
    // (required to linkify inline [n] citation markers).
    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // Turns inline citation markers like "[1]" or "[1, 3]" into superscript
    // links that jump to the matching entry in the references list. Numbers
    // without a matching reference are left as plain text so nothing is hidden.
    function linkifyCitations(text, refIds) {
        return escapeHtml(text).replace(/\[([\d\s,;]+)\]/g, (match, inner) => {
            const nums = inner.split(/[\s,;]+/).filter(Boolean);
            if (!nums.length) return match;
            const parts = nums.map(n => {
                const id = Number(n);
                return refIds.has(id)
                    ? `<a href="#ref-${id}" class="cite-link">${id}</a>`
                    : String(id);
            });
            return `<sup class="cite">[${parts.join(', ')}]</sup>`;
        });
    }

    // Waits for the background analysis to finish by polling the status
    // endpoint with the job's id. Resolves with the analysis result, or throws
    // on a reported error or overall timeout.
    async function pollForResult(jobId, { intervalMs = 3000, timeoutMs = 5 * 60 * 1000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, intervalMs));

            let res;
            try {
                res = await fetch(`/.netlify/functions/analyzeRiskStatus?jobId=${encodeURIComponent(jobId)}`);
            } catch {
                continue; // transient network hiccup — keep polling
            }
            if (!res.ok) continue;

            const payload = await res.json();
            if (payload.status === 'done') return payload.result;
            if (payload.status === 'error') throw new Error(payload.message || 'Analyse fehlgeschlagen.');
            // status === 'processing' — keep polling
        }
        throw new Error('Zeitüberschreitung: Die Analyse dauert länger als erwartet.');
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const company = input.value.trim();
        if (!company) return;

        // Reset UI
        resultsContainer.classList.add('hidden');
        introSection.classList.add('hidden');
        loadingState.classList.remove('hidden');
        btnText.classList.add('hidden');
        spinner.classList.remove('hidden');
        analyzeBtn.disabled = true;

        const loadingSteps = [
            "Initiiere KI-Recherche...",
            "Prüfe Unternehmensidentität...",
            "Analysiere Google News & Trends...",
            "Werte Arbeitgeberplattformen aus...",
            "Kompiliere Risikomatrix...",
            "Erstelle SWOT-Analyse..."
        ];

        let stepIndex = 0;
        const interval = setInterval(() => {
            stepIndex = (stepIndex + 1) % loadingSteps.length;
            statusText.textContent = loadingSteps[stepIndex];
        }, 3000);

        try {
            // Kick off the long-running analysis as a background job. The
            // background function returns 202 immediately, so this request never
            // hits the 60s synchronous-function limit that caused 504 timeouts.
            // We then poll analyzeRiskStatus with the same job id for the result.
            const jobId = (crypto.randomUUID && crypto.randomUUID()) ||
                `${Date.now()}-${Math.random().toString(16).slice(2)}`;

            const start = await fetch('/.netlify/functions/analyzeRisk-background', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ company, jobId })
            });

            // Background functions answer with 202 Accepted; anything else that
            // is not a success means the job never started.
            if (start.status !== 202 && !start.ok) {
                throw new Error(`API Fehler: ${start.status}`);
            }

            const data = await pollForResult(jobId);

            clearInterval(interval);
            renderResults(data);

        } catch (error) {
            console.error('Fehler bei der Analyse:', error);
            clearInterval(interval);
            alert('Es gab einen Fehler bei der Analyse. Bitte stellen Sie sicher, dass die Netlify Functions korrekt konfiguriert sind und der GEMINI_API_KEY hinterlegt ist.\n\nDetails: ' + error.message);
            
            // Reset button
            loadingState.classList.add('hidden');
            introSection.classList.remove('hidden');
            btnText.classList.remove('hidden');
            spinner.classList.add('hidden');
            analyzeBtn.disabled = false;
        }
    });

    function renderResults(data) {
        // Hide loading, show results
        loadingState.classList.add('hidden');
        resultsContainer.classList.remove('hidden');
        btnText.classList.remove('hidden');
        spinner.classList.add('hidden');
        analyzeBtn.disabled = false;

        // Set of reference ids available for inline [n] citation linking.
        const refIds = new Set(
            Array.isArray(data.references) ? data.references.map(r => r.id) : []
        );

        const identity = data.identity || {};
        document.getElementById('identity-name').textContent = identity.name || 'Nicht eindeutig belegt';
        document.getElementById('identity-headquarters').textContent = identity.headquarters || 'Nicht eindeutig belegt';
        document.getElementById('identity-website').textContent = identity.website || 'Nicht eindeutig belegt';
        document.getElementById('identity-industry').textContent = identity.industry || 'Nicht eindeutig belegt';
        document.getElementById('identity-verification').innerHTML = linkifyCitations(
            identity.verification || 'Die Unternehmensidentität konnte nicht näher belegt werden.',
            refIds
        );

        // 1. Keywords
        keywordsContainer.innerHTML = '';
        if (data.keywords && Array.isArray(data.keywords)) {
            data.keywords.forEach(kw => {
                const span = document.createElement('span');
                span.className = 'keyword-tag';
                span.textContent = kw;
                keywordsContainer.appendChild(span);
            });
        }

        // 2. Risks
        const risks = [
            { id: 'geo', data: data.risks.geopolitics },
            { id: 'rep', data: data.risks.reputation },
            { id: 'crime', data: data.risks.crime },
            { id: 'burglary', data: data.risks.burglary },
            { id: 'protest', data: data.risks.protests },
            { id: 'terror', data: data.risks.terrorism },
            { id: 'insider', data: data.risks.insider }
        ];

        risks.forEach(risk => {
            const scoreEl = document.getElementById(`score-${risk.id}`);
            const fillEl = document.getElementById(`fill-${risk.id}`);
            const reasonEl = document.getElementById(`reason-${risk.id}`);

            if (risk.data) {
                const score = risk.data.score; // 0 to 10
                scoreEl.textContent = `${score}/10`;
                
                // Color based on score
                let color = 'var(--success)';
                if (score >= 4) color = 'var(--warning)';
                if (score >= 7) color = 'var(--danger)';
                
                // Animate width
                setTimeout(() => {
                    fillEl.style.width = `${score * 10}%`;
                    fillEl.style.backgroundColor = color;
                }, 100);

                reasonEl.innerHTML = linkifyCitations(risk.data.reason, refIds);
            }
        });

        // 3. SWOT
        const populateList = (id, items) => {
            const ul = document.getElementById(`swot-${id}`);
            ul.innerHTML = '';
            if (items && Array.isArray(items)) {
                items.forEach(item => {
                    const li = document.createElement('li');
                    li.innerHTML = linkifyCitations(item, refIds);
                    ul.appendChild(li);
                });
            }
        };

        if (data.swot) {
            populateList('s', data.swot.strengths);
            populateList('w', data.swot.weaknesses);
            populateList('o', data.swot.opportunities);
            populateList('t', data.swot.threats);
        }

        // 4. Summary
        if (data.summary) {
            aiSummary.innerHTML = linkifyCitations(data.summary, refIds);
        }

        // 5. Numbered references (targets for the inline [n] citations)
        renderReferences(data.references);

        // 6. Grounded sources
        renderSources(data.sources);
    }

    function renderReferences(references) {
        const list = document.getElementById('references-list');
        const empty = document.getElementById('references-empty');
        list.innerHTML = '';

        const items = Array.isArray(references) ? references : [];
        if (!items.length) {
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');

        items.forEach(ref => {
            const li = document.createElement('li');
            li.id = `ref-${ref.id}`;
            li.value = ref.id; // keep the ordered-list number aligned with [n]

            if (ref.url) {
                const a = document.createElement('a');
                a.href = ref.url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = ref.title || ref.url;
                li.appendChild(a);
            } else {
                li.textContent = ref.title;
            }
            list.appendChild(li);
        });
    }

    function renderSources(sources) {
        const list = document.getElementById('sources-list');
        const empty = document.getElementById('sources-empty');
        list.innerHTML = '';

        const items = Array.isArray(sources) ? sources : [];
        if (!items.length) {
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');

        items.forEach(src => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = src.uri;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = src.title || src.uri;
            li.appendChild(a);
            list.appendChild(li);
        });
    }
});
