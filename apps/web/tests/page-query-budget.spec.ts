import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { credentials, ensureLocalFixtures, signIn } from "./local-fixtures";
import { apiDirectory, php, platform, platformOwnerCredentials, signInToPlatform } from "./platform-fixtures";

type Metrics = { requests: number; central: number; tenant: number; total: number; recorded: number; duplicates: number; sql_ms: number };

function telescopeCursor(): number {
  return Number(execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    if (!app()->isLocal() || config('database.connections.central.database') !== 'courses_central') {
      throw new \RuntimeException('Browser query measurements require local courses_central');
    }
    echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0;
  `], { cwd: apiDirectory, stdio: "pipe" }).toString().trim());
}

function metricsAfter(cursor: number, host: string): Metrics {
  const result = execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    $requests = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
      ->where('type', 'request')->where('sequence', '>', (int) getenv('COURSES_TEST_CURSOR'))
      ->whereRaw("content::jsonb->'headers'->>'host' = ?", [getenv('COURSES_TEST_HOST')])
      ->get(['batch_id', 'content']);
    $queries = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
      ->where('type', 'query')->whereIn('batch_id', $requests->pluck('batch_id'))->pluck('content')
      ->map(fn ($content) => json_decode($content, true));
    $counts = $queries->countBy('connection');
    $patterns = $queries->countBy(fn ($query) => $query['connection'].':'.$query['hash']);
    $headers = $requests->map(fn ($row) => json_decode($row->content, true)['response_headers']);
    echo json_encode([
      'requests' => $requests->count(), 'central' => $counts['central'] ?? 0, 'tenant' => $counts['tenant'] ?? 0,
      'total' => $headers->sum(fn ($header) => (int) ($header['x-courses-query-count'] ?? -1)),
      'recorded' => $queries->count(), 'duplicates' => $patterns->filter(fn ($count) => $count > 1)->count(),
      'sql_ms' => round($headers->sum(fn ($header) => (float) ($header['x-courses-sql-ms'] ?? 0)), 2),
    ]);
  `], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_CURSOR: String(cursor), COURSES_TEST_HOST: host }, stdio: "pipe" }).toString().trim();
  return JSON.parse(result) as Metrics;
}

async function measure(page: Page, url: string, cold: boolean): Promise<Metrics> {
  const cursor = telescopeCursor();
  if (cold) execFileSync(php, ["artisan", "cache:clear", "--no-interaction"], { cwd: apiDirectory, stdio: "pipe" });
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  const host = new URL(url).hostname;
  await expect.poll(() => metricsAfter(cursor, host).requests, { timeout: 10_000 }).toBeGreaterThan(0);
  const metrics = metricsAfter(cursor, host);
  expect(metrics.total).toBeGreaterThan(0);
  expect(metrics.recorded).toBe(metrics.total);
  expect(metrics.central + metrics.tenant).toBe(metrics.total);
  expect(metrics.total).toBeLessThanOrEqual(6);
  return metrics;
}

test("every ordinary authenticated page stays within six queries on cold and warm loads", async ({ browser }) => {
  test.setTimeout(300_000);
  await ensureLocalFixtures(browser);
  const alpha = await browser.newPage();
  const beta = await browser.newPage();
  const landlord = await browser.newPage();
  const report: { page: string; cold: Metrics; warm: Metrics }[] = [];
  try {
    const alphaOwner = credentials("alpha");
    const betaOwner = credentials("beta");
    const platformOwner = platformOwnerCredentials();
    await signIn(alpha, "http://alpha.courses.test", alphaOwner.email, alphaOwner.password);
    await signIn(beta, "http://beta.courses.test", betaOwner.email, betaOwner.password);
    await signInToPlatform(landlord, platformOwner.email, platformOwner.password);
    for (const [page, host] of [[alpha, "alpha.courses.test"], [beta, "beta.courses.test"]] as const) {
      for (const route of ["admin", "admin/settings", "admin/members", "admin/audit", "admin/security"]) {
        const url = `http://${host}/${route}`;
        report.push({ page: `${host}/${route}`, cold: await measure(page, url, true), warm: await measure(page, url, false) });
      }
    }
    const centers = await (await landlord.request.get(`${platform}/api/v1/platform/centers?search=alpha`)).json();
    const centerId = centers.data.find((center: { slug: string }) => center.slug === "alpha")?.id;
    expect(centerId).toBeTruthy();
    await landlord.goto(`${platform}/admin/users`);
    const userEditPath = await landlord.locator('a[href*="/admin/users/"]').evaluateAll((links) => links
      .map((link) => (link as HTMLAnchorElement).pathname).find((href) => /^\/admin\/users\/[^/]+\/edit$/.test(href)));
    expect(userEditPath).toBeTruthy();
    for (const route of ["admin", "admin/centers", "admin/centers/create", "admin/users/create", userEditPath!.slice(1), "admin/users", "admin/platform-audit-logs", `admin/centers/${centerId}`, `admin/centers/${centerId}/edit`]) {
      const url = `${platform}/${route}`;
      report.push({ page: `courses.test/${route}`, cold: await measure(landlord, url, true), warm: await measure(landlord, url, false) });
    }
    const directory = path.resolve(process.cwd(), "test-results");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "page-query-budget.json"), JSON.stringify({ measured_at: new Date().toISOString(), pages: report }, null, 2));
  } finally {
    await Promise.all([alpha.close(), beta.close(), landlord.close()]);
  }
});
