const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
    try {
        // Inputs aus der action.yml abrufen
        const apiKey = core.getInput('gemini-api-key');
        const githubToken = core.getInput('github-token');
        const model = core.getInput('model');

        const { owner, repo } = github.context.repo;
        const issueNumber = github.context.issue.number;

        if (github.context.eventName !== 'pull_request') {
            core.setFailed("Diese Action ist nur für Pull Request Events vorgesehen.");
            return;
        }

        // Octokit-Client initialisieren
        const octokit = github.getOctokit(githubToken);

        // System-Anweisung für Gemini, um strukturiertes JSON zu generieren
        const systemPrompt = `
            Du bist ein erfahrener Software-Architekt und führst ein Code-Review durch.
            Deine Aufgabe ist es, den bereitgestellten Code-Diff zu analysieren.
            Gebe dein Feedback NUR im folgenden JSON-Format zurück, wobei du Fehler, Sicherheitslücken und Verbesserungen direkt an der betroffenen Zeile kommentierst.
            
            ***KRITISCHE ANWEISUNG FÜR ZEILENNUMMER***
            Die 'line' MUSS die Zeilennummer in der ZIELDATEI (nach der Änderung) sein.
            Die Zeile MUSS auf einer Zeile basieren, die im Diff mit einem PLUS-Zeichen (+) beginnt.
            Ignoriere Zeilen, die gelöscht wurden (-) oder Kontextzeilen ( ).
            Du musst die Zeilennummer aus der Hunk-Header-Information (z.B. '@@ -X,Y +A,B @@') ableiten, indem du die Startzeile (A) und die Anzahl der hinzugefügten Zeilen (B) nutzt.
            
            Wenn es keine Kommentare gibt, antworte mit einer leeren JSON-Liste: [].

            JSON-Schema:
            [
              {
                "path": "string", // Der Dateipfad, z.B. "src/server.js"
                "line": "number", // Die Zeilennummer in der NEUEN Datei (MUSS eine Zeile mit '+ ' sein).
                "comment": "string" // Der detaillierter Kommentar in deutscher Sprache.
              }
            ]
        `;

        // 1. Diff vom GitHub API Endpunkt abrufen
        const diffResponse = await octokit.rest.pulls.get({
            owner,
            repo,
            pull_number: issueNumber,
            headers: { 'Accept': 'application/vnd.github.v3.diff' }
        });

        const codeDiff = diffResponse.data;
        if (!codeDiff || codeDiff.length < 10) {
            core.info("Kein signifikanter Code-Diff gefunden. Überspringe die Überprüfung.");
            return;
        }
        core.info(`Code-Diff erfolgreich abgerufen. Größe: ${codeDiff.length} Bytes.`);

        // 2. Gemini API Payload erstellen mit JSON Schema
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const userQuery = 'Bitte analysiere den folgenden Code-Diff und generiere die Kommentare als JSON:\n\n' + codeDiff;

        const responseSchema = {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    path: { type: "STRING" },
                    line: { type: "NUMBER" },
                    comment: { type: "STRING" }
                },
                required: ["path", "line", "comment"]
            }
        };

        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: responseSchema
            }
        };

        core.info(`Sende strukturierte JSON-Anfrage an Gemini API.`);

        // 3. Gemini API aufrufen und JSON parsen (mit Retry-Mechanismus)
        let aiReviewComments = [];
        let rawJsonText = '';

        for (let i = 0; i < 3; i++) { // 3 Versuche
            try {
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    throw new Error(`API Fehler: ${response.statusText}`);
                }

                const result = await response.json();
                const candidate = result.candidates?.[0];
                if (candidate && candidate.content?.parts?.[0]?.text) {
                    rawJsonText = candidate.content.parts[0].text;
                    aiReviewComments = JSON.parse(rawJsonText);
                    break; // Erfolg
                }
                throw new Error('Kein Text in der Gemini-Antwort gefunden.');

            } catch (error) {
                core.warning(`Versuch ${i + 1} fehlgeschlagen (Gemini/JSON-Parsing): ${error.message}`);
                if (i === 2) throw new Error(`Gemini API-Aufruf oder JSON-Parsing nach mehreren Versuchen fehlgeschlagen. Letzte rohe Antwort: ${rawJsonText}`);
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // Exponential Backoff
            }
        }

        core.info(`Gemini hat ${aiReviewComments.length} Kommentare generiert.`);

        // 4. Kommentare für GitHub Review formatieren

        const githubComments = aiReviewComments.map(c => ({
            path: c.path,
            line: c.line,
            body: c.comment
        }));

        if (githubComments.length === 0) {
            await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: issueNumber,
                body: "## 🤖 KI Code Review von Gemini\n\nKeine kritischen Probleme gefunden. **Sieht gut aus!**"
            });
            core.info('Keine Kommentare, positiver Gesamtkommentar gepostet.');
            return;
        }

        // 5. Review mit allen zeilenspezifischen Kommentaren posten
        const reviewSummary = `
            ## 🤖 KI Code Review von Gemini
            
            Ich habe ${githubComments.length} spezifische Kommentare zu den Änderungen hinterlassen. Bitte überprüfen Sie die markierten Zeilen im "Files changed"-Tab.
            
            ---
            
            *Bitte beachten: Ich bin eine KI und meine Vorschläge sind nur Empfehlungen. Ein menschliches Review ist weiterhin unerlässlich!*
        `;

        try {
            await octokit.rest.pulls.createReview({
                owner,
                repo,
                pull_number: issueNumber,
                event: 'COMMENT', // Postet die Kommentare ohne Genehmigung anzufordern
                body: reviewSummary,
                comments: githubComments
            });
            core.info('Review mit zeilenspezifischen Kommentaren erfolgreich gepostet.');
        } catch (error) {
            if (error.status === 422) {
                core.warning(`FEHLER: Die GitHub API lehnte den Review ab (422 Unprocessable Entity). Dies deutet darauf hin, dass die KI ungültige Zeilennummern generiert hat.`);

                // FALLBACK: Posten des Gesamt-Reviews als normalen Kommentar
                const fallbackBody = `
                    ## ⚠️ KI Review mit Fehler (Fallback)
                    
                    **Der Versuch, zeilenspezifische Kommentare zu setzen, ist aufgrund ungültiger Zeilennummern (422 Fehler) fehlgeschlagen.**
                    
                    Hier ist das generierte Feedback als Gesamtkommentar:
                    
                    ---
                    
                    **Zusammenfassung:** ${reviewSummary.replace('## 🤖 KI Code Review von Gemini', '')} 
                    
                    **Details zum Feedback:**
                    ${githubComments.map(c => `- **${c.path} (Zeile ${c.line}):** ${c.body}`).join('\n')}
                `;

                await octokit.rest.issues.createComment({
                    owner,
                    repo,
                    issue_number: issueNumber,
                    body: fallbackBody
                });
                core.warning('Als Gesamtkommentar gepostet. Die Action wird fortgesetzt.');
            } else {
                // Anderer Fehler, den wir weitergeben
                throw error;
            }
        }
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
