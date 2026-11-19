// What a service spends on models (DEC-0021, DEC-0065, DEC-0091): receipts, the ledger, the usage report and its rules (FAC-SEM-025), OpenRouter attribution (FAC-SEM-098), spending limits (DEC-0027).
// Part of the Node service kit (FAA-65, layer L3); the twin of fabric_usage.py. Node 20+, no dependency.
import fs from 'node:fs';
import path from 'node:path';
import { normalIdentifier } from './fabric-identifiers.mjs';
import { parseRfc3339Ms as strictTime, utcDateMs, utcDay as utcDate } from './fabric-time.mjs'; // the core's (FAA-65)
const emptyRow = (extra = {}) => ({ ...extra, calls: 0, unpricedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 });
import { show, toNumber } from './fabric-jsvalue.mjs';
import { PROTOCOL, ServiceError, nowIso } from './fabric-base.mjs';
import { atomicWrite, ensurePrivateDir } from './fabric-paths.mjs';

export const ROUTES = Object.freeze(['subscription', 'key']);

/** A usage row's route (DEC-0046, DEC-0061): beside a configuration's two, the hosting platform's own metered models. */
export const USAGE_ROUTES = Object.freeze([...ROUTES, 'platform-metered']);

export const USAGE_PATH = '/fabric/v1/usage';

export const USAGE_DAYS = 31;

export const COST_BASES = ['provider', 'price-list', 'unknown'];

const PROVIDER = /^[a-z][a-z0-9._-]{0,63}$/;

const COUNTS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/**
 * One model call, from the provider's own usage numbers. No prompt, output or caller.
 * `costUsd` null means it cannot be priced: the report counts it as unpriced, never as $0.
 */
/**
 * One model call. `projectId` (a URI, kept in its normal form, DEC-0076) and `taskRunId` (the service's own run id) attribute
 * it to the project the service ran it for (DEC-0065); they never name a caller, session or person.
 */
// tokensMeasured: false marks a call whose token counts are a lower bound or unknown (DEC-0091): the report counts it
// in unmeasuredCalls and its token totals are a lower bound.
export function makeUsageReceipt(provider, model, { inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, costUsd = null, costBasis, at, route, projectId, taskRunId, tokensMeasured = true } = {}) {
  if (!PROVIDER.test(provider ?? '')) throw new ServiceError('provider must be a lowercase name such as anthropic or openrouter.');
  model = String(model ?? '').trim();
  if (!model || model.length > 128) throw new ServiceError('model must be 1 to 128 characters.');
  const counts = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  for (const [name, value] of Object.entries(counts)) if (!Number.isInteger(value) || value < 0) throw new ServiceError(`${name} must be a non-negative integer.`);
  if (costUsd !== null && (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0)) throw new ServiceError('costUsd must be a non-negative number or null.');
  const basis = costBasis ?? (costUsd === null ? 'unknown' : 'provider');
  if (!COST_BASES.includes(basis) || (costUsd === null) !== (basis === 'unknown')) throw new ServiceError('costBasis is provider or price-list with a cost, unknown without one.');
  if (route !== undefined && !USAGE_ROUTES.includes(route)) throw new ServiceError('route is subscription, key or platform-metered (DEC-0046, DEC-0061).');
  if (tokensMeasured !== true && tokensMeasured !== false) throw new ServiceError('tokensMeasured is true or false.');
  if (taskRunId !== undefined && projectId === undefined) throw new ServiceError('a task run belongs to a project: give projectId with taskRunId.');
  if (projectId !== undefined && !(typeof projectId === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(projectId))) throw new ServiceError('projectId is the URI of the project the service ran the call for.');
  if (taskRunId !== undefined && !(typeof taskRunId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskRunId))) throw new ServiceError("taskRunId is the service's own run id: ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$.");
  return { at: at ?? nowIso(), provider, model, ...counts, costUsd, costBasis: basis, ...(tokensMeasured ? {} : { tokensMeasured: false }), ...(route === undefined ? {} : { route }),
    ...(projectId === undefined ? {} : { projectId: normalIdentifier(projectId) }), ...(taskRunId === undefined ? {} : { taskRunId }) };
}

/** DEC-0065's `byProject`: the window's calls by project (normal form, DEC-0076), each task run once within it. */
function byProject(receipts, first, last) {
  const projects = new Map();
  const add = (row, r) => { row.calls += 1; if (r.costUsd === null || r.costUsd === undefined) row.unpricedCalls += 1; else row.cost += r.costUsd; };
  for (const r of receipts) {
    const date = String(r.at ?? '').slice(0, 10);
    if (date < first || date > last || !r.projectId) continue;
    if (!projects.has(r.projectId)) projects.set(r.projectId, { projectId: r.projectId, calls: 0, unpricedCalls: 0, cost: 0, runs: new Map() });
    const row = projects.get(r.projectId);
    add(row, r);
    if (r.taskRunId) {
      if (!row.runs.has(r.taskRunId)) row.runs.set(r.taskRunId, { taskRunId: r.taskRunId, calls: 0, unpricedCalls: 0, cost: 0 });
      add(row.runs.get(r.taskRunId), r);
    }
  }
  const close = ({ cost, ...rest }) => ({ ...rest, costUsd: rest.calls && rest.unpricedCalls === rest.calls ? null : Math.round(cost * 1e6) / 1e6 });
  return [...projects.keys()].sort().map((key) => {
    const { runs, ...row } = projects.get(key);
    const taskRuns = [...runs.keys()].sort().map((id) => close(runs.get(id)));
    return { ...close(row), ...(taskRuns.length ? { taskRuns } : {}) };
  });
}

function closeRow(row) {
  const { cost, ...rest } = row;
  return { ...rest, costUsd: rest.calls && rest.unpricedCalls === rest.calls ? null : Math.round(cost * 1e6) / 1e6 };
}

/**
 * The service-usage.schema.json answer: the last 31 UTC days, oldest first, per provider and
 * model; days without calls are omitted. A row whose calls are all unpriced costs null; totals
 * are the sums of the model rows (FAC-SEM-025).
 */
const usageCount = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

const usageCost = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

const exceeds = (a, b) => a - b > 0.000001 + 1e-9 * Math.max(Math.abs(a), Math.abs(b));

const usd = (v) => String(Math.round(v * 1e6) / 1e6);

const usageList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'object' && x !== null && !Array.isArray(x)) : []);

function pricedRow(row, at) {
  const calls = usageCount(row.calls), unpriced = usageCount(row.unpricedCalls);
  const flag = (p, message) => [{ code: 'FAC-SEM-025', instancePath: p, message }];
  if (unpriced > calls) return flag(`${at}/unpricedCalls`, 'more unpriced calls than calls');
  // DEC-0091: calls whose token count is unknown are some of the calls, never more.
  if (usageCount(row.unmeasuredCalls) > calls) return flag(`${at}/unmeasuredCalls`, 'more calls with unknown tokens than calls');
  if (calls > 0 && unpriced === calls && row.costUsd !== null) return flag(`${at}/costUsd`, 'every call is unpriced, so the cost is unknown (null), not a number');
  if (unpriced < calls && row.costUsd === null) return flag(`${at}/costUsd`, 'priced calls carry a cost; null is only for a row with no priced call');
  return [];
}

/**
 * FAC-SEM-025 over a usage report, in the contract's order (`src/usage-rules.ts`): the arithmetic, the window (every
 * date exists, not after `generatedAt`'s UTC date, at most 30 days before it) and the project attribution (each project
 * once by its normal form, each task run once; calls, priced calls and known costs bounded). Never throws.
 */
export function usageFindings(report) {
  const value = typeof report === 'object' && report !== null && !Array.isArray(report) ? report : {};
  const findings = [];
  const flag = (instancePath, message) => findings.push({ code: 'FAC-SEM-025', instancePath, message });
  const days = usageList(value.days);
  let previous = '';
  days.forEach((day, i) => {
    const at = `/days/${i}`;
    const date = show(day.date ?? '');
    if (date <= previous) flag(`${at}/date`, `days must run forward without a repeat (${date} after ${previous})`);
    previous = date;
    findings.push(...pricedRow(day, at));
    const models = usageList(day.byModel);
    models.forEach((m, j) => findings.push(...pricedRow(m, `${at}/byModel/${j}`)));
    if (!models.length) {
      const spent = ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some((f) => toNumber(day[f] ?? 0) > 0) || toNumber(day.costUsd ?? 0) > 0;
      if (spent) flag(`${at}/byModel`, 'a day with calls, tokens or cost names the models they belong to');
      return;
    }
    for (const field of ['calls', 'unpricedCalls', 'unmeasuredCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      const sum = models.reduce((n, m) => n + toNumber(m[field] ?? 0), 0);
      if (toNumber(day[field] ?? 0) !== sum) flag(`${at}/${field}`, `the day's ${field} is not the sum of its models (${show(day[field] ?? 0)} ≠ ${sum})`);
    }
    const known = models.map((m) => (typeof m.costUsd === 'number' ? m.costUsd : null)).filter((x) => x !== null).reduce((n, x) => n + x, 0);
    // The contract's !close(day, known): Infinity or NaN is never close, so it is a finding.
    if (typeof day.costUsd === 'number' && !(Math.abs(day.costUsd - known) <= 0.000001 + 1e-9 * Math.max(Math.abs(day.costUsd), Math.abs(known)))) flag(`${at}/costUsd`, "the day's cost is not the sum of its models' known costs");
  });
  if (days.length) {
    const generated = strictTime(value.generatedAt);
    if (Number.isNaN(generated)) flag('/generatedAt', 'generatedAt is an RFC 3339 date-time with an offset, so the window can be read');
    else {
      const today = Math.floor(generated / 86_400_000) * 86_400_000;
      const oldest = today - 30 * 86_400_000;
      days.forEach((day, i) => {
        const date = utcDateMs(day.date);
        if (Number.isNaN(date)) flag(`/days/${i}/date`, "a day's date exists in its month");
        else if (date > today) flag(`/days/${i}/date`, 'a day is not after the UTC date of generatedAt');
        else if (date < oldest) flag(`/days/${i}/date`, 'a day is within the last 31 UTC days of generatedAt');
      });
    }
  }
  if (Array.isArray(value.byProject)) {
    const seen = new Map();
    let projectCalls = 0, projectCost = 0;
    value.byProject.forEach((project, p) => {
      if (typeof project !== 'object' || project === null || Array.isArray(project)) return;
      const at = `/byProject/${p}`;
      const normal = normalIdentifier(project.projectId);
      if (normal !== undefined) {
        if (seen.has(normal)) flag(`${at}/projectId`, `each project is one row: ${show(project.projectId)} names the project ${seen.get(normal)} already names`);
        else seen.set(normal, show(project.projectId));
      }
      projectCalls += usageCount(project.calls);
      projectCost += usageCost(project.costUsd);
      findings.push(...pricedRow(project, at));
      const runs = new Set();
      let runCalls = 0, runCost = 0, runPriced = 0;
      usageList(project.taskRuns).forEach((run, r) => {
        if (typeof run.taskRunId === 'string') {
          if (runs.has(run.taskRunId)) flag(`${at}/taskRuns/${r}/taskRunId`, 'each task run is one row within its project');
          runs.add(run.taskRunId);
        }
        runCalls += usageCount(run.calls);
        runCost += usageCost(run.costUsd);
        runPriced += Math.max(0, usageCount(run.calls) - usageCount(run.unpricedCalls));
        findings.push(...pricedRow(run, `${at}/taskRuns/${r}`));
      });
      const projectPriced = Math.max(0, usageCount(project.calls) - usageCount(project.unpricedCalls));
      if (runCalls > usageCount(project.calls)) flag(`${at}/taskRuns`, `a project's task runs hold more calls than the project (${runCalls} > ${usageCount(project.calls)})`);
      else if (runPriced > projectPriced) flag(`${at}/taskRuns`, `a project's task runs hold more priced calls than the project (${runPriced} > ${projectPriced})`);
      else if (usageCost(project.costUsd) === project.costUsd && exceeds(runCost, usageCost(project.costUsd))) flag(`${at}/taskRuns`, `a project's task runs cost more than the project (${usd(runCost)} > ${usd(usageCost(project.costUsd))})`);
    });
    const dayCalls = days.reduce((n, d) => n + usageCount(d.calls), 0);
    if (projectCalls > dayCalls) flag('/byProject', `the projects hold more calls than the days (${projectCalls} > ${dayCalls})`);
    const dayCost = days.reduce((n, d) => n + usageCost(d.costUsd), 0);
    if (exceeds(projectCost, dayCost)) flag('/byProject', `the projects cost more than the days (${usd(projectCost)} > ${usd(dayCost)})`);
  }
  return findings;
}

export const OPENROUTER_CATEGORIES = Object.freeze(['cli-agent', 'ide-extension', 'cloud-agent', 'programming-app', 'native-app-builder',
  'creative-writing', 'video-gen', 'image-gen', 'audio-gen', 'writing-assistant', 'general-chat', 'personal-agent', 'legal', 'roleplay', 'game']);

const ATTR_PRODUCT = /^[a-z][a-z0-9-]{0,62}$/;

const ATTR_TITLE = /^[\x21-\x7e](?:[\x20-\x7e]{0,98}[\x21-\x7e])?$/;

const ATTRIBUTION_HEADER_NAMES = new Set(['http-referer', 'referer', 'x-openrouter-title', 'x-title', 'x-openrouter-categories']);

/** FAC-SEM-098: a product's setting names a product slug, a printable title and at most two recognized categories. */
export function attributionSettingFindings(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ code: 'FAC-SEM-098', instancePath: '', message: 'an attribution setting is an object' }];
  const findings = [];
  const flag = (instancePath, message) => findings.push({ code: 'FAC-SEM-098', instancePath, message });
  if (typeof value.product !== 'string' || !ATTR_PRODUCT.test(value.product)) flag('/product', 'the product is a lower-case slug, the last segment of its product page');
  if (typeof value.title !== 'string' || !ATTR_TITLE.test(value.title)) flag('/title', "the title is the product's full name: printable ASCII, 1 to 100 characters, no space at either end");
  if (value.categories !== undefined) {
    if (!Array.isArray(value.categories)) flag('/categories', 'categories are a list');
    else {
      if (value.categories.length > 2) flag('/categories', 'at most 2 categories per request');
      const seen = new Set();
      value.categories.forEach((c, i) => {
        if (typeof c !== 'string' || !OPENROUTER_CATEGORIES.includes(c)) flag(`/categories/${i}`, 'a category is one OpenRouter recognizes; it drops others without an error');
        else if (seen.has(c)) flag(`/categories/${i}`, 'each category once');
        else seen.add(c);
      });
    }
  }
  return findings;
}

function isOpenRouter(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'openrouter.ai' && u.port === '' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

/**
 * The headers a product adds to one request (DEC-0065, the contract's `attributionHeaders`), or none with the reason:
 * `no-setting` (off by default), `invalid-setting`, `not-openrouter`, `forwarded`, `user-set`. Only `HTTP-Referer`,
 * `X-OpenRouter-Title` and `X-OpenRouter-Categories`; it never reads, moves or returns a key.
 */
export function attributionHeaders(setting, given) {
  const request = typeof given === 'object' && given !== null ? given : {};
  if (setting === undefined || setting === null) return { headers: {}, none: 'no-setting' };
  if (attributionSettingFindings(setting).length) return { headers: {}, none: 'invalid-setting' };
  if (typeof request.url !== 'string' || !isOpenRouter(request.url)) return { headers: {}, none: 'not-openrouter' };
  if (request.originated !== true) return { headers: {}, none: 'forwarded' };
  const present = typeof request.headers === 'object' && request.headers !== null ? Object.keys(request.headers).map((n) => n.toLowerCase()) : [];
  if (present.some((n) => ATTRIBUTION_HEADER_NAMES.has(n))) return { headers: {}, none: 'user-set' };
  const headers = { 'HTTP-Referer': `https://passioncode.ai/${setting.product}/`, 'X-OpenRouter-Title': setting.title };
  if (setting.categories?.length) headers['X-OpenRouter-Categories'] = setting.categories.join(',');
  return { headers };
}

/**
 * `budgets` (DEC-0027) lists every spending limit the service applies, enforced or not. A machine limit with a
 * calendar `period` and no `spentUsd` is counted here from the receipts, the way `budget` is, so the two never
 * disagree; a per-order limit (`per_job`, `approval`) gets `spentUsd: null`; every other limit states its own spend.
 * A report whose limits break FAC-SEM-031 is refused (`usageLimitProblems`).
 */
export function usageReport(receipts, { id, instance = 'default', now = Date.now(), budget, budgets } = {}) {
  receipts = Array.from(receipts); // read twice: the days, then a rolling window
  const first = utcDate(now - (USAGE_DAYS - 1) * 86_400_000), last = utcDate(now);
  const days = new Map();
  for (const r of receipts) {
    const date = String(r.at ?? '').slice(0, 10);
    if (date < first || date > last) continue;
    const rows = days.get(date) ?? new Map();
    days.set(date, rows);
    const k = `${r.provider}\u0000${r.model}\u0000${r.route ?? ''}`;
    // DEC-0046: rows of one model on two routes stay apart.
    const row = rows.get(k) ?? emptyRow({ provider: r.provider, model: r.model, ...(r.route ? { route: r.route } : {}), bases: new Set() });
    rows.set(k, row);
    row.calls += 1;
    for (const c of COUNTS) row[c] += Number(r[c] ?? 0);
    if (r.costUsd === null || r.costUsd === undefined) row.unpricedCalls += 1; else row.cost += r.costUsd;
    if (r.tokensMeasured === false) row.unmeasuredCalls = (row.unmeasuredCalls ?? 0) + 1; // absent is 0 (DEC-0091)
    row.bases.add(r.costBasis ?? 'unknown');
  }
  const outDays = [...days.keys()].sort().map((date) => {
    const models = [...days.get(date).values()]
      .map(({ bases, ...row }) => closeRow({ ...row, costBasis: bases.size === 1 ? [...bases][0] : 'mixed' }))
      .sort((a, b) => (`${a.provider}\u0000${a.model}\u0000${a.route ?? ''}` < `${b.provider}\u0000${b.model}\u0000${b.route ?? ''}` ? -1 : 1));
    const day = emptyRow({ date });
    for (const m of models) {
      for (const c of ['calls', 'unpricedCalls', ...COUNTS]) day[c] += m[c];
      if (m.unmeasuredCalls) day.unmeasuredCalls = (day.unmeasuredCalls ?? 0) + m.unmeasuredCalls;
      day.cost += m.costUsd ?? 0;
    }
    return { ...closeRow(day), byModel: models };
  });
  const report = { protocol: PROTOCOL, service: { id, instance }, generatedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), currency: 'USD', days: outDays };
  const projects = byProject(receipts, first, last);
  if (projects.length) report.byProject = projects;
  if (budget !== undefined) {
    if (!['day', 'month'].includes(budget?.period) || typeof budget.limitUsd !== 'number' || !(budget.limitUsd > 0)) throw new ServiceError('budget is {period: day|month, limitUsd > 0}.');
    report.budget = { period: budget.period, limitUsd: budget.limitUsd, spentUsd: spentIn(outDays, budget.period, last) };
  }
  if (budgets !== undefined) {
    report.budgets = budgets.map((given) => {
      if (!isPlainObject(given)) throw new ServiceError('Each limit in budgets is an object.');
      const limit = { ...given };
      if (!('spentUsd' in limit)) {
        if (PER_ORDER_KINDS.includes(limit.kind)) limit.spentUsd = null;
        else if (limit.scope === 'machine' && ['day', 'month'].includes(limit.period)) limit.spentUsd = spentIn(outDays, limit.period, last);
        else if (limit.scope === 'machine' && isNumber(limit.windowSeconds)) limit.spentUsd = spentSince(receipts, now - limit.windowSeconds * 1000, now);
      }
      return limit;
    });
    const problems = usageLimitProblems(report);
    if (problems.length) throw new ServiceError(`The report's limits are not coherent: ${problems.join('; ')}`);
  }
  return report;
}

/**
 * What a host shows for usage rows (DEC-0110, the contract's usageSpend): money spent apart from a subscription's
 * estimate. `rows` are `days[].byModel[]` rows. Money is the `costUsd` of every row whose `route` is `key`,
 * `platform-metered` or absent; a `subscription` row's `costUsd` is an estimate at list price, summed apart. A window
 * whose calls were all on a subscription spent 0; money is null only when it has calls off a subscription and none of
 * them is priced, and a lower bound while some are priced and some are not. An unknown `route`, or counts or a cost the
 * schema refuses, answers undefined. It never throws on a JSON value.
 */
export function usageSpend(rows) {
  if (!Array.isArray(rows)) return undefined;
  const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const money = [], estimate = [];
  let calls = 0, subscriptionCalls = 0;
  const paid = { calls: 0, priced: 0, unpriced: false }, sub = { calls: 0, priced: 0, unpriced: false };
  for (const row of rows) {
    if (!isPlainObject(row)) return undefined;
    const { route } = row;
    if (route !== undefined && !(typeof route === 'string' && USAGE_ROUTES.includes(route))) return undefined;
    const rowCalls = row.calls, unpriced = row.unpricedCalls === undefined ? 0 : row.unpricedCalls, rowCost = row.costUsd;
    if (!Number.isSafeInteger(rowCalls) || rowCalls < 0 || !Number.isSafeInteger(unpriced) || unpriced < 0 || unpriced > rowCalls) return undefined;
    if (rowCost !== null && !known(rowCost)) return undefined;
    if (rowCalls > 0 && (rowCost === null) !== (unpriced === rowCalls)) return undefined; // FAC-SEM-025's own pairing
    calls += rowCalls;
    const side = route === 'subscription' ? sub : paid;
    if (route === 'subscription') subscriptionCalls += rowCalls;
    side.calls += rowCalls;
    side.priced += rowCalls - unpriced;
    if (unpriced > 0) side.unpriced = true;
    if (known(rowCost)) (route === 'subscription' ? estimate : money).push(rowCost);
  }
  const total = (side, costs) => (side.calls > 0 && side.priced === 0 ? null : costs.sort((a, b) => a - b).reduce((n, x) => n + x, 0));
  return {
    calls,
    moneyUsd: total(paid, money),
    moneyLowerBound: paid.priced > 0 && paid.unpriced,
    estimateUsd: total(sub, estimate),
    estimateLowerBound: sub.priced > 0 && sub.unpriced,
    subscriptionCalls,
  };
}

/** CT-115: a limit counts money only, never a subscription's estimate (DEC-0110). */
function money(spend) {
  return spend === undefined || spend.moneyUsd === null ? null : Math.round(spend.moneyUsd * 1e6) / 1e6;
}

/** Money spent in a rolling window, from the receipts' own times; null when no call off a subscription in it is priced. */
function spentSince(receipts, start, end) {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const lo = iso(start), hi = iso(end);
  const inside = [...receipts].filter((r) => String(r.at ?? '') > lo && String(r.at ?? '') <= hi);
  const priced = (r) => r.costUsd !== null && r.costUsd !== undefined;
  return money(usageSpend(inside.map((r) => ({ ...(r.route ? { route: r.route } : {}), calls: 1, unpricedCalls: priced(r) ? 0 : 1, costUsd: priced(r) ? r.costUsd : null }))));
}

/** Money spent in the current UTC day or month, over the window's model rows; null when no call off a subscription in it is priced. */
function spentIn(outDays, period, last) {
  const prefix = period === 'day' ? last : last.slice(0, 7);
  return money(usageSpend(outDays.filter((d) => d.date.startsWith(prefix)).flatMap((d) => d.byModel)));
}

export const LIMIT_SCOPES = Object.freeze(['machine', 'project', 'pool', 'job']);

export const PER_ORDER_KINDS = Object.freeze(['per_job', 'approval']);

const LIMIT_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

const LIMIT_KIND = /^[a-z][a-z0-9_]{0,31}$/;

const LIMIT_FIELDS = ['id', 'scope', 'subject', 'kind', 'period', 'windowSeconds', 'since', 'limitUsd', 'spentUsd', 'enforced', 'tripped'];

const TIMESTAMP = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?([Zz]|[+-]([0-9]{2}):([0-9]{2}))$/;

/** A JSON Schema `date-time` (RFC 3339): a real calendar date and time, `Z` or an offset. */
export function isTimestamp(value) {
  const m = typeof value === 'string' ? value.match(TIMESTAMP) : null;
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const calendar = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  const offset = m[9] === undefined || (Number(m[9]) <= 23 && Number(m[10]) <= 59);
  return calendar && hour <= 23 && minute <= 59 && second <= 60 && offset;
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The `budgets` of a usage report against `service-usage.schema.json` `$defs/limit` and FAC-SEM-031 — the twin of
 * fabric_service.usage_limit_problems. A breach is not a problem, and an unknown kind is never refused.
 */
export function usageLimitProblems(report) {
  const problems = [];
  const limits = report?.budgets;
  if (limits === undefined) return problems;
  if (!Array.isArray(limits) || limits.length > 64) return ['budgets is a list of at most 64 limits'];
  const seen = new Set();
  limits.forEach((limit, i) => {
    const at = `/budgets/${i}`;
    if (!isPlainObject(limit)) { problems.push(`${at} is not an object`); return; }
    for (const key of Object.keys(limit)) if (!LIMIT_FIELDS.includes(key)) problems.push(`${at}/${key} is not a limit field`);
    for (const key of ['id', 'scope', 'kind', 'limitUsd', 'spentUsd', 'enforced']) if (!(key in limit)) problems.push(`${at} is missing ${key}`);
    if ('id' in limit && !(typeof limit.id === 'string' && LIMIT_ID.test(limit.id))) problems.push(`${at}/id must match ${LIMIT_ID.source}`);
    if ('scope' in limit && !LIMIT_SCOPES.includes(limit.scope)) problems.push(`${at}/scope must be one of ${LIMIT_SCOPES.join(', ')}`);
    if ('subject' in limit && !(typeof limit.subject === 'string' && limit.subject.length >= 1 && limit.subject.length <= 128)) problems.push(`${at}/subject is 1 to 128 characters`);
    if ('kind' in limit && !(typeof limit.kind === 'string' && LIMIT_KIND.test(limit.kind))) problems.push(`${at}/kind must match ${LIMIT_KIND.source}`);
    if ('period' in limit && !['day', 'month'].includes(limit.period)) problems.push(`${at}/period is day or month`);
    if ('windowSeconds' in limit && !(Number.isInteger(limit.windowSeconds) && limit.windowSeconds >= 1)) problems.push(`${at}/windowSeconds is a whole number of seconds, at least 1`);
    if ('since' in limit && !isTimestamp(limit.since)) problems.push(`${at}/since is a UTC timestamp`);
    if ('limitUsd' in limit && !(limit.limitUsd === null || (isNumber(limit.limitUsd) && limit.limitUsd > 0))) problems.push(`${at}/limitUsd is a dollar amount above zero, or null`);
    if ('spentUsd' in limit && !(limit.spentUsd === null || (isNumber(limit.spentUsd) && limit.spentUsd >= 0))) problems.push(`${at}/spentUsd is a dollar amount, zero or more, or null`);
    for (const key of ['enforced', 'tripped']) if (key in limit && typeof limit[key] !== 'boolean') problems.push(`${at}/${key} is true or false`);

    const flag = (where, message) => problems.push(`FAC-SEM-031 ${at}/${where}: ${message}`);
    const id = String(limit.id ?? '');
    if (seen.has(id)) flag('id', `limit id ${id} appears twice`);
    seen.add(id);
    const named = limit.scope === 'project' || limit.scope === 'pool';
    if (named && !('subject' in limit)) flag('subject', `a ${limit.scope} limit names its ${limit.scope} in subject`);
    if (!named && 'subject' in limit) flag('subject', `a ${limit.scope} limit has no subject`);
    const windows = ['period', 'windowSeconds', 'since'].filter((f) => f in limit);
    if (windows.length > 1) flag(windows[1], `a limit has one window, not ${windows.join(' and ')}`);
    const kind = String(limit.kind ?? '');
    const seconds = isNumber(limit.windowSeconds) ? limit.windowSeconds : null;
    if (PER_ORDER_KINDS.includes(kind)) {
      if (windows.length) flag(windows[0], `${kind} bounds one order and has no window`);
      if (limit.spentUsd !== null) flag('spentUsd', `${kind} bounds one order, so nothing is spent against it (null)`);
    } else if (kind === 'daily') {
      if (!(limit.period === 'day' || seconds === 86400)) flag('period', 'a daily limit counts the UTC day (period day) or the last 24 hours (windowSeconds 86400)');
    } else if (kind === 'monthly') {
      if (!(limit.period === 'month' || (seconds !== null && seconds >= 28 * 86400 && seconds <= 31 * 86400))) flag('period', 'a monthly limit counts the UTC month (period month) or a rolling 28–31 days (windowSeconds)');
    } else if (kind === 'velocity') {
      if (seconds === null) flag('windowSeconds', 'a velocity limit counts a rolling window (windowSeconds)');
    } else if (kind === 'pool' || kind === 'emergency') {
      if (!windows.length) flag('period', `a ${kind} limit names the window it counts (period, windowSeconds or since)`);
    }
    const known = PER_ORDER_KINDS.includes(kind) || ['daily', 'monthly', 'pool', 'emergency'].includes(kind);
    if (known && 'limitUsd' in limit && limit.limitUsd === null) flag('limitUsd', `a ${kind} limit is a dollar amount; only a relative limit (velocity) may leave it null`);
    if (limit.tripped === true && limit.enforced !== true) flag('tripped', 'a limit that is not enforced cannot have stopped work');
  });
  const budget = report.budget;
  if (isPlainObject(budget) && limits.length) {
    const kind = budget.period === 'day' ? 'daily' : 'monthly';
    const same = (x, y) => (x === null || y === null ? x === y : isNumber(x) && isNumber(y) && Math.abs(x - y) <= 0.000001);
    const twin = limits.some((l) => isPlainObject(l) && l.scope === 'machine' && l.enforced === true && l.kind === kind && l.period === budget.period && same(l.limitUsd, budget.limitUsd) && same(l.spentUsd, budget.spentUsd));
    if (!twin) problems.push(`FAC-SEM-031 /budget: budget repeats one enforced machine ${kind} limit with period ${budget.period} in budgets[], so old and new readers agree`);
  }
  return problems;
}

/** Usage receipts for services that keep none yet: append-only JSON lines, 0600, pruned to the window (LC-12).
 *  One writer process (the service holds its instance lock); every method is synchronous, so calls never interleave. */
export class JsonlUsageLedger {
  constructor(file) { this.file = file; }

  record(receipt) {
    ensurePrivateDir(path.dirname(this.file));
    const fd = fs.openSync(this.file, 'a+', 0o600);
    try {
      const { size } = fs.fstatSync(fd);
      const last = Buffer.alloc(1);
      // A killed writer left a torn line: never glue a receipt to it.
      const lead = size && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a ? '\n' : '';
      fs.writeSync(fd, lead + JSON.stringify(receipt) + '\n');
    } finally {
      fs.closeSync(fd);
    }
  }

  receipts() {
    if (!fs.existsSync(this.file)) return [];
    const out = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn last line from a killed writer is skipped */ }
    }
    return out;
  }

  prune(now = Date.now()) {
    const first = utcDate(now - (USAGE_DAYS - 1) * 86_400_000);
    const all = this.receipts();
    const kept = all.filter((r) => String(r.at ?? '').slice(0, 10) >= first);
    if (kept.length !== all.length) atomicWrite(this.file, kept.map((r) => JSON.stringify(r) + '\n').join(''));
    return all.length - kept.length;
  }

  report(options) { return usageReport(this.receipts(), options); }
}
