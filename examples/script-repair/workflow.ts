type FilePath = string;

declare function run_script_tests_by_code(lang: string, script: string, inputs: {
    source: FilePath;
    tests: FilePath;
    expectedTestHash: string
}): Promise<{ passed: boolean; report: string; testExitCode: number; exit_code: number }>;

declare function repair_script_by_ai(role: string, prompt: string, source: FilePath, tests: FilePath, report: string): Promise<{
    source: FilePath
}>;

async function testScript(source: FilePath, tests: FilePath, expectedTestHash: string): Promise<{
    passed: boolean;
    report: string;
    testExitCode: number;
    valid: boolean
}> {
    const result = await run_script_tests_by_code("python", `
from pathlib import Path
import hashlib
import json
import subprocess
import sys
source_file = Path(source).resolve()
test_file = Path(tests).resolve()
if not source_file.is_file() or source_file.stat().st_size > 65536:
    raise ValueError("Source must be an existing file of at most 64 KiB")
def check_tests():
    if not test_file.is_file() or hashlib.sha256(test_file.read_bytes()).hexdigest() != expectedTestHash:
        raise ValueError("Test file changed or disappeared; refusing to trust the test result")
check_tests()
try:
    child = subprocess.run([sys.executable, "-B", str(test_file)], cwd=str(source_file.parent), capture_output=True, text=True, timeout=5)
    testExitCode = child.returncode
    report = (child.stdout + child.stderr)[-4096:]
    try:
        summary = json.loads(child.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        summary = {}
    passed = child.returncode == 0 and isinstance(summary, dict) and summary.get("suite") == "average" and summary.get("testsRun") == 6 and summary.get("successful") is True
    if child.returncode == 0 and not passed:
        report += chr(10) + "No confirmed completion of all six tests; exit zero alone is insufficient."
except subprocess.TimeoutExpired:
    testExitCode = -1
    passed = False
    report = "Test process exceeded the 5-second limit and was stopped. Check the script for a loop or blocking work."
check_tests()
`, {source, tests, expectedTestHash});
    return {
        passed: result.passed,
        report: result.report,
        testExitCode: result.testExitCode,
        valid: result.exit_code === 0
    };
}

export async function main(source: FilePath, tests: FilePath, expectedTestHash: string): Promise<{
    source: FilePath;
    passed: boolean;
    repairs: number;
    report: string;
    reason: string
}> {
    for (let repair = 0; repair <= 2; repair++) {
        const checked = await testScript(source, tests, expectedTestHash);
        if (!checked.valid) return {
            source,
            passed: false,
            repairs: repair,
            report: checked.report,
            reason: "Code test runner failed"
        };
        if (checked.passed) return {
            source,
            passed: true,
            repairs: repair,
            report: checked.report,
            reason: "All six tests passed"
        };
        if (repair === 2) return {
            source,
            passed: false,
            repairs: repair,
            report: checked.report,
            reason: "Repair limit reached; tests still fail"
        };
        const fixed = await repair_script_by_ai("Python maintainer", "Read source and the fixed tests. Use the actual Code test report to make the smallest correction to average(values): return the arithmetic mean without changing the input, and raise ValueError for empty input. Modify only source, in place. Do not change tests or test infrastructure, install dependencies, use the network, or run tests yourself; the workflow runs them after your edit. Actually save the correction and return the same relative source path. Do not claim success merely because you edited the file.", source, tests, checked.report);
        if (fixed.source !== source) return {
            source,
            passed: false,
            repairs: repair + 1,
            report: checked.report,
            reason: "AI returned a different source path; inspect its effects before starting again"
        };
    }
    return {source, passed: false, repairs: 2, report: "", reason: "Script repair did not finish"};
}
