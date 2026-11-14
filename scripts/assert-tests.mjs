#!/usr/bin/env node
// Fail closed on test execution: parses Vitest JSON reports and refuses to pass
// when a suite executed zero tests, passed zero tests, or skipped everything.
//
// Usage:
//   node scripts/assert-tests.mjs --suite unit
//   node scripts/assert-tests.mjs --suite unit --exclude @platform/web
//   node scripts/assert-tests.mjs --suite integration --filter @platform/db
//   node scripts/assert-tests.mjs --report reports/unit --label unit
//   node scripts/assert-tests.mjs --suite unit --coverage --thresholds lines=50,functions=50
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    suite: null,
    label: null,
    report: null,
    filters: [],
    excludes: [],
    coverage: false,
    thresholds: null,
    minTests: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--suite') args.suite = argv[++i];
    else if (arg.startsWith('--suite=')) args.suite = arg.split('=')[1];
    else if (arg === '--label') args.label = argv[++i];
    else if (arg.startsWith('--label=')) args.label = arg.split('=')[1];
    else if (arg === '--report') args.report = argv[++i];
    else if (arg.startsWith('--report=')) args.report = arg.split('=')[1];
    else if (arg === '--filter') args.filters.push(argv[++i]);
    else if (arg.startsWith('--filter=')) args.filters.push(arg.split('=')[1]);
    else if (arg === '--exclude') args.excludes.push(argv[++i]);
    else if (arg.startsWith('--exclude=')) args.excludes.push(arg.split('=')[1]);
    else if (arg === '--coverage') args.coverage = true;
    else if (arg === '--thresholds') args.thresholds = argv[++i];
    else if (arg.startsWith('--thresholds=')) args.thresholds = arg.split('=')[1];
    else if (arg === '--min-tests') args.minTests = Number(argv[++i]);
    else if (arg.startsWith('--min-tests=')) args.minTests = Number(arg.split('=')[1]);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/assert-tests.mjs --suite unit|integration [--filter name] [--exclude name] [--coverage] [--thresholds lines=50,...] [--report dir] [--label text]',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  if (!args.suite && !args.report) throw new Error('suite_or_report_required');
  if (args.suite && !['unit', 'integration'].includes(args.suite)) {
    throw new Error(`invalid_suite:${args.suite}`);
  }
  return args;
}

function discoverPackages() {
  const packages = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(groupDir, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      packages.push({
        name: manifest.name,
        dir: join(group, entry.name),
        scripts: manifest.scripts ?? {},
      });
    }
  }
  return packages;
}

function safeName(name) {
  return name.replace(/^@/u, '').replace(/[^a-zA-Z0-9_.-]+/gu, '-');
}

function runSuite(args) {
  const scriptName = args.suite === 'unit' ? 'test' : 'test:integration';
  const reportDir = args.report ?? join(root, 'reports', args.suite);
  const coverageDir = join(root, 'reports', 'coverage');
  mkdirSync(reportDir, { recursive: true });

  const packages = discoverPackages().filter((pkg) => {
    if (!pkg.scripts[scriptName]) return false;
    if (args.filters.length > 0 && !args.filters.includes(pkg.name)) return false;
    if (args.excludes.includes(pkg.name)) return false;
    return true;
  });
  if (packages.length === 0) {
    console.error(`[assert-tests] no packages found for ${scriptName}`);
    process.exit(1);
  }

  const commandFailures = [];
  const reportFiles = [];
  for (const pkg of packages) {
    const reportPath = join(reportDir, `${safeName(pkg.name)}.json`);
    const extra = [
      '--reporter=json',
      `--outputFile=${reportPath}`,
      ...(args.coverage
        ? [
            '--coverage',
            '--coverage.reporter=json-summary',
            '--coverage.reporter=text-summary',
            `--coverage.reportsDirectory=${join(coverageDir, safeName(pkg.name))}`,
          ]
        : []),
    ];
    console.log(`[assert-tests] ${pkg.name} -> ${scriptName}`);
    const result = spawnSync('pnpm', ['--filter', pkg.name, 'run', scriptName, ...extra], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) commandFailures.push(pkg.name);
    if (existsSync(reportPath)) reportFiles.push({ packageName: pkg.name, path: reportPath });
    else console.error(`[assert-tests] ${pkg.name} produced no JSON report`);
  }
  return { reportFiles, commandFailures, coverageDir };
}

function readReports(files) {
  return files.map((file) => {
    const path = typeof file === 'string' ? file : file.path;
    const packageName = typeof file === 'string' ? path : file.packageName;
    const raw = readFileSync(path, 'utf8');
    let json;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new Error(`invalid_vitest_json:${path}:${error.message}`);
    }
    return { packageName, path, json };
  });
}

function summarize(report) {
  const { json } = report;
  const total = Number(json.numTotalTests ?? 0);
  const passed = Number(json.numPassedTests ?? 0);
  const failed = Number(json.numFailedTests ?? 0);
  const pending = Number(json.numPendingTests ?? 0);
  const todo = Number(json.numTodoTests ?? 0);
  const assertions = (json.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
  const assertionPassed = assertions.filter((a) => a.status === 'passed').length;
  const assertionFailed = assertions.filter((a) => a.status === 'failed').length;
  return {
    total,
    passed: Math.max(passed, assertionPassed),
    failed: Math.max(failed, assertionFailed),
    skipped: pending + todo,
    files: (json.testResults ?? []).length,
  };
}

function parseThresholds(value) {
  if (!value) return null;
  const thresholds = {};
  for (const pair of value.split(',')) {
    const [metric, raw] = pair.split('=');
    const number = Number(raw);
    if (
      !['lines', 'statements', 'functions', 'branches'].includes(metric) ||
      !Number.isFinite(number)
    ) {
      throw new Error(`invalid_threshold:${pair}`);
    }
    thresholds[metric] = number;
  }
  return thresholds;
}

function coverageTotals(coverageDir) {
  if (!existsSync(coverageDir)) return null;
  const totals = { lines: [0, 0], statements: [0, 0], functions: [0, 0], branches: [0, 0] };
  for (const entry of readdirSync(coverageDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const summaryPath = join(coverageDir, entry.name, 'coverage-summary.json');
    if (!existsSync(summaryPath)) continue;
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    for (const metric of Object.keys(totals)) {
      totals[metric][0] += Number(summary.total?.[metric]?.covered ?? 0);
      totals[metric][1] += Number(summary.total?.[metric]?.total ?? 0);
    }
  }
  const percentages = {};
  for (const [metric, [covered, total]] of Object.entries(totals)) {
    percentages[metric] = total === 0 ? 0 : (covered / total) * 100;
  }
  return percentages;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[assert-tests] ${error.message}`);
    process.exit(2);
  }

  const errors = [];
  let reportFiles = [];
  let commandFailures = [];
  let coverageDir = join(root, 'reports', 'coverage');

  if (args.suite) {
    ({ reportFiles, commandFailures, coverageDir } = runSuite(args));
  } else {
    const dir = resolve(args.report);
    if (!existsSync(dir)) {
      console.error(`[assert-tests] report directory not found: ${dir}`);
      process.exit(1);
    }
    reportFiles = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ packageName: name.replace(/\.json$/u, ''), path: join(dir, name) }));
  }

  if (reportFiles.length === 0) errors.push('no Vitest JSON reports produced');
  if (commandFailures.length > 0) errors.push(`test command failed: ${commandFailures.join(', ')}`);

  let reports = [];
  try {
    reports = readReports(reportFiles);
  } catch (error) {
    errors.push(error.message);
  }

  let totalTests = 0;
  let totalPassed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  console.log('\n[assert-tests] package                     files  total  passed  failed  skipped');
  for (const report of reports) {
    const summary = summarize(report);
    totalTests += summary.total;
    totalPassed += summary.passed;
    totalSkipped += summary.skipped;
    totalFailed += summary.failed;
    console.log(
      `[assert-tests] ${report.packageName.padEnd(28)} ${String(summary.files).padStart(5)} ${String(summary.total).padStart(6)} ${String(summary.passed).padStart(7)} ${String(summary.failed).padStart(7)} ${String(summary.skipped).padStart(8)}`,
    );
    if (summary.total === 0) {
      errors.push(`${report.packageName}: 0 tests executed`);
    } else if (summary.total < args.minTests) {
      errors.push(`${report.packageName}: ${summary.total} tests < minimum ${args.minTests}`);
    }
    if (summary.passed === 0) errors.push(`${report.packageName}: 0 tests passed`);
    if (summary.total > 0 && summary.skipped === summary.total) {
      errors.push(`${report.packageName}: all ${summary.total} tests were skipped`);
    }
    if (summary.failed > 0) errors.push(`${report.packageName}: ${summary.failed} tests failed`);
    if (report.json.success === false && summary.failed === 0) {
      errors.push(`${report.packageName}: Vitest reported success=false`);
    }
  }

  if (totalTests === 0) errors.push('suite executed 0 tests');
  if (totalPassed === 0) errors.push('suite passed 0 tests');
  if (totalSkipped === totalTests && totalTests > 0) errors.push('suite skipped every test');

  const thresholds = parseThresholds(args.thresholds);
  if (thresholds) {
    const coverage = coverageTotals(coverageDir);
    if (!coverage) {
      errors.push('coverage thresholds requested but no coverage-summary.json was produced');
    } else {
      console.log('\n[assert-tests] coverage thresholds');
      for (const [metric, minimum] of Object.entries(thresholds)) {
        const actual = coverage[metric] ?? 0;
        const verdict = actual + 1e-9 >= minimum ? 'ok' : 'below';
        console.log(
          `[assert-tests] ${metric.padEnd(12)} ${actual.toFixed(2)}% (min ${minimum}%) ${verdict}`,
        );
        if (verdict === 'below')
          errors.push(`coverage ${metric} ${actual.toFixed(2)}% < ${minimum}%`);
      }
    }
  }

  console.log(
    `\n[assert-tests] total=${totalTests} passed=${totalPassed} failed=${totalFailed} skipped=${totalSkipped}`,
  );
  if (errors.length > 0) {
    console.error('\n[assert-tests] FAIL');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`[assert-tests] PASS (${args.label ?? args.suite ?? 'reports'})`);
}

main();
