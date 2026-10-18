declare function provide_requirements_by_human(prompt: string): Promise<{ focus: string }>;
declare function summarize_text_by_ai(role: string, prompt: string, text: string, focus: string): Promise<{ report: string }>;
declare function save_summary_by_code(lang: string, script: string, inputs: { report: string }): Promise<{ exit_code: number }>;

export async function main(text: string): Promise<{ saved: boolean }> {
    const requirements = await provide_requirements_by_human("What should the summary focus on?");
    const summary = await summarize_text_by_ai(
        "analyst", "Summarize text in 1–2 sentences using focus. Return report; do not use tools.",
        text, requirements.focus
    );
    const saved = await save_summary_by_code("python", `
with open("summary.md", "x", encoding="utf-8") as output:
    output.write(report)
`, { report: summary.report });
    return { saved: saved.exit_code === 0 };
}
