declare function summarize_items_by_code(lang: string, script: string, inputs: {
    items: { title: string; value: number }[]
}): Promise<{ report: string; total: number; exit_code: number }>;

declare function review_report_by_human(prompt: string, report: string, total: number): Promise<{ approved: boolean }>;

declare function save_report_by_code(lang: string, script: string, inputs: { report: string }): Promise<{
    exit_code: number
}>;

export async function main(items: { title: string; value: number }[]): Promise<{
    saved: boolean;
    total: number;
    reason: string
}> {
    const summary = await summarize_items_by_code("python", `
total = sum(item["value"] for item in items)
lines = ["# Local report", ""]
for item in items:
    lines.append("- " + item["title"] + ": " + format(item["value"], "g"))
lines.extend(["", "Total: " + format(total, ".15g"), ""])
report = "\\n".join(lines)
`, {items});
    if (summary.exit_code !== 0) {
        return {saved: false, total: 0, reason: "Summary code failed; no report saved"};
    }
    const review = await review_report_by_human("Review this report and reply with approved. The workflow saves it when approved is true.", summary.report, summary.total);
    if (!review.approved) {
        return {saved: false, total: summary.total, reason: "Report not saved: you declined approval"};
    }
    const saved = await save_report_by_code("python", `
with open("report.md", "x", encoding="utf-8") as output:
    output.write(report)
`, {report: summary.report});
    if (saved.exit_code !== 0) {
        return {saved: false, total: summary.total, reason: "Save code failed; inspect output before retrying"};
    }
    return {saved: true, total: summary.total, reason: "Saved report"};
}
