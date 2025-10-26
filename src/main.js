import * as core from '@actions/core';
import * as github from '@actions/github';

/**
 * Main function of the action
 * @returns {Promise<void>}
 */
export async function run() {
    try {
        const init = initializeAction();
        if (!init) return;

        const { apiKey, model, context, octokit } = init;
        const { owner, repo, issueNumber } = context;

        // 1. Fetch the code diff
        const codeDiff = await fetchCodeDiff(octokit, owner, repo, issueNumber);

        if (!codeDiff) return;

        // 2. Get the review comments from Gemini
        const aiReviewComments = await getGeminiReview(apiKey, model, codeDiff);

        // 3. Post the comments to GitHub
        await postReviewComments(
            octokit,
            owner,
            repo,
            issueNumber,
            issueNumber,
            aiReviewComments
        );
    } catch (error) {
        core.setFailed(error.message);
    }
}

/**
 * Retrieves inputs and initializes the GitHub client.
 * @param {string} githubToken - The GitHub token.
 * @returns {{apiKey: string, githubToken: string, model: string, context: {owner: string, repo: string, issueNumber: number}, octokit: import('@actions/github/node_modules/@octokit/rest').Octokit}}
 */
function initializeAction() {
    const apiKey = core.getInput('gemini-api-key');
    const githubToken = core.getInput('github-token');
    const model = core.getInput('model');

    const { owner, repo } = github.context.repo;
    const issueNumber = github.context.issue.number;

    if (github.context.eventName !== 'pull_request') {
        core.setFailed('This action is only available for pull requests!');
        return null;
    }

    const octokit = github.getOctokit(githubToken);

    return {
        apiKey,
        githubToken,
        model,
        context: { owner, repo, issueNumber },
        octokit,
    };
}

/**
 * Fetches the code diff from the GitHub API.
 * @param {import('@actions/github/node_modules/@octokit/rest').Octokit} octokit - Initialized octokit client.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @param {number} pull_number - The Pull Request number.
 * @returns {Promise<string | null>} The code diff as a string, or null if not significant.
 */
async function fetchCodeDiff(octokit, owner, repo, pull_number) {
    core.info('Fetching diffs from GitHub...');
    const diffResponse = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number,
        headers: { Accept: 'application/vnd.github.v3.diff' },
    });

    const codeDiff = diffResponse.data;
    if (!codeDiff || codeDiff.length < 10) {
        core.info('No significant diff found. Skipping validation.');
        return null;
    }

    core.info(`Code diff successfully fetched. Size: ${codeDiff.length} Bytes.`);
    return codeDiff;
}

// System instruction for Gemini to enforce structured JSON output.
const GEMINI_SYSTEM_PROMPT = `
    You are an experienced Software Architect conducting a code review.
    Your task is to analyze the provided code diff.
    Return your feedback ONLY in the following JSON format, commenting on bugs, security vulnerabilities, and improvements directly on the affected line.
    
    ***CRITICAL INSTRUCTION FOR LINE NUMBER***
    The 'line' MUST be the line number in the TARGET FILE (after the change).
    The line MUST be based on a line that starts with a PLUS sign (+) in the diff.
    Ignore lines that were deleted (-) or context lines ( ).
    You MUST derive the line number from the Hunk Header Information (e.g., '@@ -X,Y +A,B @@') by using the starting line (A) and the number of added lines (B).
    
    If there are no comments, reply with an empty JSON list: [].
    
    JSON Schema:
    [
      {
        "path": "string", // The file path, e.g., "src/server.js"
        "line": "number", // The line number in the NEW file (MUST be a line starting with '+ ').
        "comment": "string" // The detailed comment, in German.
      }
    ]
`;

/**
 * Calls the Gemini API with the code diff and parses the structured JSON response.
 * Includes a retry mechanism for failed responses/parsing errors.
 * @param {string} apiKey - The Gemini API Key.
 * @param {string} model - The Gemini model to use.
 * @param {string} codeDiff - The code diff to analyze.
 * @returns {Promise<Array<{path: string, line: number, comment: string}>>} The generated review comments.
 * @throws {Error} If the API call or JSON parsing fails after multiple attempts.
 */
async function getGeminiReview(apiKey, model, codeDiff) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const userQuery =
        'Please analyze the following code-diff and write the comments as JSON:\n\n' +
        codeDiff;

    const responseSchema = {
        type: 'ARRAY',
        items: {
            type: 'OBJECT',
            properties: {
                path: { type: 'STRING' },
                line: { type: 'NUMBER' },
                comment: { type: 'STRING' },
            },
            required: ['path', 'line', 'comment'],
        },
    };

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: responseSchema,
        },
    };

    core.info(`Sending structured JSON request to Gemini. Model: ${model}.`);

    let rawJsonText = '';
    for (let i = 0; i < 3; i++) {
        try {
            // NOTE: Using 'X-Goog-Api-Key' header for better security practice
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': apiKey,
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.statusText}`);
            }

            const result = await response.json();
            const candidate = result.candidates?.[0];
            if (candidate && candidate.content?.parts?.[0]?.text) {
                rawJsonText = candidate.content.parts[0].text;
                const comments = JSON.parse(rawJsonText);
                core.info(`Gemini has generated ${comments.length} comments.`);
                return comments; // Success
            }
            throw new Error('No text found in Gemini response');
        } catch (error) {
            core.warning(
                `Try ${i + 1} failed (Gemini/JSON-Parsing): ${error.message}`
            );
            if (i === 2)
                throw new Error(
                    `Gemini API request has failed after multiple tries. Last raw response: ${rawJsonText}`
                );
            await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1))); // Exponential Backoff
        }
    }
}

/**
 * Posts the generated comments as a Pull Request Review or as a fallback comment.
 * @param {import('@actions/github/node_modules/@octokit/rest').Octokit} octokit - Initialized octokit client.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @param {number} pull_number - The Pull Request number.
 * @param {number} issue_number - The Issue number (for fallback comments).
 * @param {Array<{path: string, line: number, comment: string}>} aiReviewComments - The generated comments.
 */
async function postReviewComments(
    octokit,
    owner,
    repo,
    pull_number,
    issue_number,
    aiReviewComments
) {
    const githubComments = aiReviewComments.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.comment,
    }));

    if (githubComments.length === 0) {
        const body =
            '## 🤖 AI Code Review by Gemini\n\nNo critical issues found. **Looks good!**';
        await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number,
            body,
        });
        core.info('No comments generated; posted a positive summary comment.');
        return;
    }

    const reviewSummary = `
    ## 🤖 AI Code Review by Gemini
    
    I've left ${githubComments.length} specific comments on the changes. Please check the marked lines in the "Files changed" tab.
    
    ---
    
    *Please note: I am an AI, and my suggestions are recommendations only. A human review remains essential!*
  `;

    try {
        await octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number,
            event: 'COMMENT', // Posts comments without requesting approval
            body: reviewSummary,
            comments: githubComments,
        });
        core.info('Review with line-specific comments successfully posted.');
    } catch (error) {
        if (error.status === 422) {
            core.warning(
                `ERROR: The GitHub API rejected the review (422 Unprocessable Entity). This indicates the AI generated invalid line numbers.`
            );

            // FALLBACK: Post the entire review as a regular issue comment
            const fallbackBody = `
        ## ⚠️ AI Review Error (Fallback)
        
        **The attempt to set line-specific comments failed due to invalid line numbers (422 error).**
        
        Here is the generated feedback as a general comment:
        
        ---
        
        **Summary:** ${reviewSummary.replace(
                '## 🤖 AI Code Review by Gemini',
                ''
            )} 
        
        **Feedback Details:**
        ${githubComments
                .map((c) => `- **${c.path} (Line ${c.line}):** ${c.body}`)
                .join('\n')}
      `;

            await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number,
                body: fallbackBody,
            });
            core.warning('Posted as a general comment. Action continues.');
        } else {
            throw error;
        }
    }
}