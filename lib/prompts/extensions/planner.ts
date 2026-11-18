import type { IdFormat } from "../../message-ids"
import { formatMessageRef } from "../../message-ids"

export function plannerRangeInstructions(format: IdFormat = "xml"): string {
    const example = formatMessageRef(1, format)
    const exampleEnd = formatMessageRef(2, format)
    return `
PLANNER MODE (ACTIVE)

Target selection and summaries are delegated to DCP's configured planner model. Do NOT do the compression thinking yourself.

- Prefer calling this tool with only \`topic\` (and optional \`focus\`). DCP will choose the safest older ranges automatically using its low-cost planner model.
- If you already know exactly which range to compress, you may pass \`content\` with \`startId\` and \`endId\` but OMIT \`summary\`. DCP will write the summary.
- Only pass your own \`summary\` when you have a specific reason to control the wording.
- Never call this tool on the latest user request or content still needed verbatim for the active task.

Example auto-plan call:
\`\`\`
{ "topic": "Closed Research Notes", "focus": "keep decisions about the auth refactor" }
\`\`\`

Example targeted call:
\`\`\`
{ "topic": "Old Exploration", "content": [ { "startId": "${example}", "endId": "${exampleEnd}" } ] }
\`\`\`
`
}

export function plannerMessageInstructions(format: IdFormat = "xml"): string {
    const example = formatMessageRef(1, format)
    return `
PLANNER MODE (ACTIVE)

Target selection and summaries are delegated to DCP's configured planner model. Do NOT do the compression thinking yourself.

- Prefer calling this tool with only \`topic\` (and optional \`focus\`). DCP will choose the safest older messages automatically using its low-cost planner model.
- If you already know exactly which messages to compress, you may pass \`content\` entries with \`messageId\` and \`topic\` but OMIT \`summary\`. DCP will write the summaries.
- Only pass your own \`summary\` when you have a specific reason to control the wording.
- Never call this tool on the latest user request or content still needed verbatim for the active task.

Example auto-plan call:
\`\`\`
{ "topic": "General Cleanup", "focus": "preserve API constraints" }
\`\`\`

Example targeted call:
\`\`\`
{ "topic": "Old Exploration", "content": [ { "messageId": "${example}", "topic": "Tool Output" } ] }
\`\`\`
`
}
