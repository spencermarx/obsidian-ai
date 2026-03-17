---
description: Review a given code review markdown document, GitHub PR review, or inline feedback — corroborate each point against actual code, then implement valid changes.
---

# Review Feedback

Review a code review document, GitHub code review comment, or inline feedback. Corroborate each point against the actual implementation before acting.

## Usage

After invoking, provide:
- **REVIEW SOURCE** (one of the following):
  - A file path to a review markdown file (e.g., `.ocr/sessions/.../final.md`)
  - A GitHub PR link (e.g., `https://github.com/org/repo/pull/123`) pointing to a review or comment
  - Inline feedback pasted directly in the chat
- **NOTES** *(optional)*: Any additional instructions, constraints, or priorities to keep front of mind while reviewing and implementing.

## Guardrails

- You are a distinguished software engineer with deep understanding of software architecture and design patterns.
- Think step by step — favor composition, clear boundaries, minimal scope, and root-cause fixes.
- Verify every assumption by reading actual code; never guess at behavior.
- Adhere to existing patterns and project standards (`openspec/project.md`, `apps/dev-docs/docs/guides/coding-standards.md`).
- Do NOT blindly accept every piece of feedback. Use your expertise to corroborate each point against the actual implementation before acting.
- If feedback is incorrect or based on a misunderstanding of the code, say so clearly with evidence.
- If feedback is valid but the suggested fix is suboptimal, propose a better alternative.
- Direct cutover rewrites only — remove all deprecated/dead/unused code; leave nothing behind.

## Steps

1. **Resolve Inputs**
   - **REVIEW SOURCE**: Determine the feedback source:
     1. If the user provided a file path, read the file in its entirety to extract all review feedback.
     2. If the user provided a GitHub PR link, use `gh pr view <number> --comments` or `gh api repos/{owner}/{repo}/pulls/{number}/comments` to fetch the review content. If the link points to a specific comment, focus on that comment; otherwise, gather all review comments.
     3. If the user provided inline feedback directly, use it as-is.
     4. If none of the above are provided or are ambiguous, stop and ask the user for clarification.
   - **NOTES**: Capture any additional user instructions. These take priority and should be kept front of mind throughout all subsequent steps.

2. **Parse and Catalog Feedback Items**
   - Break the review source into discrete, actionable feedback items.
   - For each item, record:
     - The feedback point (what the reviewer is saying)
     - The file(s) and line(s) referenced (if any)
     - Severity/type: bug, style, architecture, performance, naming, test coverage, etc.
   - Present a concise numbered summary of all feedback items to the user before proceeding.

3. **Gather Implementation Context**
   - Read ALL files referenced by the review feedback.
   - Read any additional files needed to understand the surrounding context (callers, consumers, types, tests).
   - Read `openspec/project.md` and `apps/dev-docs/docs/guides/coding-standards.md` if the feedback touches on standards or architecture.
   - **DO NOT skip any referenced files** — thorough context is critical for accurate corroboration.

4. **Corroborate and Validate Each Feedback Item**
   For each feedback item from Step 2:
   - **Read the actual code** at the referenced location.
   - **Assess validity**: Is the feedback accurate? Does the code actually exhibit the issue described?
   - **Classify** each item as one of:
     - **Valid — Will Address**: Feedback is correct and should be implemented.
     - **Valid — Alternative Approach**: Feedback identifies a real issue but the suggested fix is suboptimal; propose a better solution.
     - **Invalid — Respectfully Decline**: Feedback is based on a misunderstanding or is incorrect; explain why with code evidence.
     - **Needs Clarification**: Feedback is ambiguous or requires more context to evaluate.
   - Present the corroboration results to the user as a summary table or list before implementing. Wait for user acknowledgment.

5. **Address Feedback**
   For all items classified as **Valid — Will Address** or **Valid — Alternative Approach**:
   - Implement changes following project coding standards and existing patterns.
   - Apply any user-provided NOTES as additional constraints.
   - Group related changes logically (e.g., all changes to one file together).
   - For **Alternative Approach** items, implement the better solution you proposed in Step 4.
   - Ensure every change is minimal, focused, and does not introduce regressions.
   - Run any relevant linting or type-checking commands to verify correctness.

6. **Report Completion**
   Summarize:
   - Total feedback items reviewed
   - Items addressed (with brief description of each change)
   - Items declined (with reasoning)
   - Items needing clarification (if any)
   - Any remaining follow-up actions or open questions

## Output

The workflow produces:
1. A numbered catalog of all feedback items with corroboration status
2. Implemented code changes for all valid feedback
3. A completion summary with change descriptions, declined items with reasoning, and any open questions
