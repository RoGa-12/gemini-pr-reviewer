# 🤖 Gemini PR Code Review Action

This GitHub Action utilizes the Gemini API to perform AI-powered code reviews on every Pull Request (PR). It analyzes the code changes (the diff) and posts line-specific comments directly to the affected files, mimicking a human reviewer.

## ✨ Features

Line-Specific Comments: Posts feedback directly on the lines of code being changed.

Structured Output: Forces the Gemini model to return strict JSON for reliable parsing and precise comment placement.

Graceful Fallback: If the line-specific comment fails (due to invalid line numbers), the feedback is posted as a summarized PR comment instead of failing the workflow.

Configurable Model: Use any supported Gemini model.

## 🚀 Setup

### 1. Create a Gemini API Key

You must first obtain a Gemini API key. Store this key securely in your GitHub repository secrets.

Secret Name: GEMINI_API_KEY

Value: Your actual Gemini API key.

### 2. Add the Action to your Workflow

Create or modify your GitHub Actions workflow file, typically located at .github/workflows/ai-review.yml.

Ensure your workflow grants the necessary permissions: contents: read (to get the diff) and pull-requests: write (to post the review comments).

### Example Workflow (.github/workflows/ai-review.yml)

Replace YOUR_USERNAME/YOUR_REPO_NAME@v1 with the actual path and tag of the repository where you saved this reusable action (e.g., RoGa-12/gemini-pr-reviewer@v1).

```yaml
name: AI Code Review with Gemini

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  ai_review:
    runs-on: ubuntu-latest

    # CRITICAL: Permissions required for the action to fetch the diff and post comments.
    permissions:
      contents: read
      pull-requests: write 

      steps:
        - name: Run Gemini Code Review
          # IMPORTANT: Replace with your actual repository path and tag!
          uses: RoGa-12/gemini-pr-reviewer@v1 
          with:
            # Required: Your secure Gemini API Key
            gemini-api-key: ${{ secrets.GEMINI_API_KEY }} 
          
            # Required: The token used to interact with the GitHub API
            github-token: ${{ secrets.GITHUB_TOKEN }}
          
            # Optional: Specify the model (default is gemini-2.5-flash-preview-09-2025)
            model: 'gemini-2.5-flash-preview-09-2025'
```

## 🛠️ How it Works

Trigger: The workflow starts on any new or updated Pull Request.

Diff Retrieval: The action uses the provided github-token to fetch the complete diff of the PR.

Gemini Call: The diff is sent to the specified Gemini model along with a strict systemInstruction and a responseSchema that mandates an array of JSON objects: [ { "path": "file", "line": 123, "comment": "feedback" } ].

Review Posting: The JSON output is parsed, and the action uses the GitHub pulls.createReview API endpoint to post all comments simultaneously, attaching them to the precise file path and line number in the target branch.