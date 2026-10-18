import {formatReport} from './format';

declare function draft_report_by_ai(role: string, prompt: string, topic: string, notes: string, previous: string, feedback: string, round: number): Promise<{
    report: string
}>;

declare function review_report_by_human(prompt: string, report: string, round: number): Promise<{
    approved: boolean;
    feedback: string
}>;

declare function save_report_by_code(lang: string, script: string, inputs: { report: string }): Promise<{
    exit_code: number
}>;

async function saveReport(report: string): Promise<{ saved: boolean; reason: string }> {
    const formatted = await formatReport(report);
    const result = await save_report_by_code("python", `
with open("report.md", "x", encoding="utf-8") as output:
    output.write(report)
`, {report: formatted.report});
    if (result.exit_code !== 0) return {saved: false, reason: "Save code failed; inspect output before retrying"};
    return {saved: true, reason: "Saved approved report"};
}

export async function main(topic: string, notes: string): Promise<{ saved: boolean; rounds: number; reason: string }> {
    let previous: string = '';
    let feedback: string = '';
    for (let round = 1; round <= 3; round++) {
        const draft = await draft_report_by_ai(
            "writer", "Write 1–2 sentences using topic and notes. Revise previous using feedback. Return report. No tools.",
            topic, notes, previous, feedback, round
        );
        const review = await review_report_by_human(
            "Is this report ready to save? If not, tell us what needs changing. Leave feedback blank if no changes are needed.", draft.report, round
        );
        if (review.approved) {
            const result = await saveReport(draft.report);
            return {saved: result.saved, rounds: round, reason: result.reason};
        }
        previous = draft.report;
        feedback = review.feedback;
    }
    return {saved: false, rounds: 3, reason: "After 3 rounds the report was not approved; nothing saved"};
}
