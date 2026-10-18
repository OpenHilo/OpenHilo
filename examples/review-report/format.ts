async function label(value: string): Promise<{ text: string }> {
    return {text: '# Reviewed report\n\n' + value + '\n'};
}

export async function formatReport(report: string): Promise<{ report: string }> {
    const formatted = await label(report);
    return {report: formatted.text};
}
