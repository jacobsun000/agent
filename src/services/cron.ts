import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { type Bus } from "@/bus";
import { type CronToolInput } from "@/core/tools/cron";
import { type Config } from "@/utils/config";
import { getConfiguredReportSession, loadConfiguredReportSession } from "@/utils/default-session";
import { createLogger } from "@/utils/logger";
import { type SessionTarget } from "@/utils/session-target";
import { CONFIG_PATH, pathExists } from "@/utils/utils";

const logger = createLogger("cron");
const CRONS_FILE_PATH = path.join(CONFIG_PATH, "workspace", "crons.json");
const CRON_TICK_MS = 60_000;

const intervalJobSchema = z.object({
  id: z.string().trim().min(1),
  type: z.literal("every_seconds"),
  message: z.string().trim().min(1),
  everySeconds: z.int().positive(),
  nextRunAt: z.string().trim().min(1),
  createdAt: z.string().trim().min(1)
});

const cronExprJobSchema = z.object({
  id: z.string().trim().min(1),
  type: z.literal("cron"),
  message: z.string().trim().min(1),
  cronExpr: z.string().trim().min(1),
  tz: z.string().trim().min(1),
  lastTriggeredAt: z.string().trim().min(1).optional(),
  createdAt: z.string().trim().min(1)
});

const atJobSchema = z.object({
  id: z.string().trim().min(1),
  type: z.literal("at"),
  message: z.string().trim().min(1),
  at: z.string().trim().min(1),
  createdAt: z.string().trim().min(1)
});

const cronStoreSchema = z.object({
  jobs: z.array(z.discriminatedUnion("type", [
    intervalJobSchema,
    cronExprJobSchema,
    atJobSchema
  ])).default([])
});

type StoredCronJob = z.infer<typeof cronStoreSchema>["jobs"][number];

type CronServiceConfig = {
  bus: Bus;
  config: Config;
};

type CronDispatch = {
  jobId: string;
  text: string;
};

type AddCronToolInput = {
  action: "add";
  message: string;
  every_seconds?: number;
  cron_expr?: string;
  tz?: string;
  at?: string;
};

export class CronService {
  private readonly bus: Bus;
  private reportSession: SessionTarget | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private runPromise: Promise<void> | undefined;
  private storeLock = Promise.resolve();

  constructor(config: CronServiceConfig) {
    this.bus = config.bus;
    this.reportSession = getConfiguredReportSession(config.config, "cron");
  }

  start() {
    if (this.reportSession) {
      logger.info(`Cron enabled for ${this.reportSession.channel}:${this.reportSession.chatId}; scanning every 60s.`);
    } else {
      logger.info("Cron is waiting for an approved Telegram session before dispatching scheduled work.");
    }
    this.scheduleNext(0);
  }

  async stop() {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.runPromise) {
      await this.runPromise;
    }
  }

  async handleToolAction(input: CronToolInput) {
    return this.withStoreLock(async () => {
      const store = await this.loadStore();

      switch (input.action) {
        case "list":
          return {
            jobs: store.jobs.map((job) => describeJob(job))
          };
        case "remove": {
          const jobIndex = store.jobs.findIndex((job) => job.id === input.job_id);
          if (jobIndex === -1) {
            throw new Error(`No cron job with id '${input.job_id}'.`);
          }

          const [removedJob] = store.jobs.splice(jobIndex, 1);
          await this.saveStore(store);
          return {
            removed: describeJob(removedJob)
          };
        }
        case "add": {
          const createdAt = new Date().toISOString();
          const job = createJob({
            action: "add",
            message: input.message!,
            every_seconds: input.every_seconds,
            cron_expr: input.cron_expr,
            tz: input.tz,
            at: input.at
          }, createdAt);
          store.jobs.push(job);
          await this.saveStore(store);
          return {
            added: describeJob(job)
          };
        }
      }
    });
  }

  private scheduleNext(delayMs: number) {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.runCycle();
    }, delayMs);
  }

  private async runCycle() {
    if (this.runPromise) {
      logger.warn("Skipping cron tick because a previous run is still active.");
      this.scheduleNext(CRON_TICK_MS);
      return;
    }

    this.runPromise = this.executeCycle().finally(() => {
      this.runPromise = undefined;
      this.scheduleNext(getDelayUntilNextMinute());
    });

    await this.runPromise;
  }

  private async executeCycle() {
    const dueDispatches = await this.withStoreLock(async () => {
      const store = await this.loadStore();
      const now = new Date();
      const updatedJobs: StoredCronJob[] = [];
      const dispatches: CronDispatch[] = [];

      for (const job of store.jobs) {
        const evaluation = evaluateJob(job, now);
        if (evaluation.dispatch) {
          dispatches.push(evaluation.dispatch);
        }

        if (evaluation.nextJob) {
          updatedJobs.push(evaluation.nextJob);
        }
      }

      store.jobs = updatedJobs;
      await this.saveStore(store);
      return dispatches;
    });

    const reportSession = this.getReportSession();
    if (!reportSession) {
      logger.debug("Skipping cron dispatch; default report session is not initialized yet.");
      return;
    }

    for (const dispatch of dueDispatches) {
      logger.info(`Triggering cron job ${dispatch.jobId}.`);
      void this.bus.dispatch({
        channel: reportSession.channel,
        chatId: reportSession.chatId,
        text: dispatch.text,
        source: {
          type: "scheduled",
          scheduler: "cron",
          jobId: dispatch.jobId
        }
      }).catch((error) => {
        logger.error(error instanceof Error ? error.message : error);
      });
    }
  }

  private async withStoreLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.storeLock;
    let release!: () => void;
    this.storeLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await task();
    } finally {
      release();
    }
  }

  private async loadStore(): Promise<z.infer<typeof cronStoreSchema>> {
    if (!(await pathExists(CRONS_FILE_PATH))) {
      return {
        jobs: []
      };
    }

    const raw = await readFile(CRONS_FILE_PATH, "utf8");
    const parsed = cronStoreSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => {
          const issuePath = issue.path.length > 0 ? issue.path.join(".") : "root";
          return `${issuePath}: ${issue.message}`;
        })
        .join("; ");
      throw new Error(`Invalid cron store at ${CRONS_FILE_PATH}: ${details}`);
    }

    return parsed.data;
  }

  private async saveStore(store: z.infer<typeof cronStoreSchema>) {
    await mkdir(path.dirname(CRONS_FILE_PATH), { recursive: true });
    await writeFile(CRONS_FILE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  private getReportSession() {
    if (this.reportSession) {
      return this.reportSession;
    }

    try {
      const resolved = loadConfiguredReportSession("cron");
      if (resolved) {
        this.reportSession = resolved;
        logger.info(`Cron report session initialized to ${resolved.channel}:${resolved.chatId}.`);
      }

      return resolved;
    } catch (error) {
      logger.error(error instanceof Error ? error.message : error);
      return undefined;
    }
  }
}

function createJob(input: AddCronToolInput, createdAt: string): StoredCronJob {
  const id = randomUUID();

  if (input.every_seconds !== undefined) {
    return {
      id,
      type: "every_seconds",
      message: input.message!,
      everySeconds: input.every_seconds,
      nextRunAt: new Date(Date.now() + input.every_seconds * 1000).toISOString(),
      createdAt
    };
  }

  if (input.cron_expr !== undefined) {
    compileCronExpression(input.cron_expr);
    assertValidTimeZone(input.tz!);
    return {
      id,
      type: "cron",
      message: input.message!,
      cronExpr: input.cron_expr,
      tz: input.tz!,
      createdAt
    };
  }

  const at = parseAtDateTime(input.at!, input.tz);
  return {
    id,
    type: "at",
    message: input.message!,
    at: at.toISOString(),
    createdAt
  };
}

function evaluateJob(job: StoredCronJob, now: Date): { dispatch?: CronDispatch; nextJob?: StoredCronJob } {
  if (job.type === "at") {
    const runAt = new Date(job.at);
    if (Number.isNaN(runAt.getTime())) {
      logger.warn(`Removing cron job ${job.id} because its at datetime is invalid.`);
      return {};
    }

    if (runAt.getTime() > now.getTime()) {
      return { nextJob: job };
    }

    return {
      dispatch: buildDispatch(job),
      nextJob: undefined
    };
  }

  if (job.type === "every_seconds") {
    const nextRunAt = new Date(job.nextRunAt);
    if (Number.isNaN(nextRunAt.getTime())) {
      logger.warn(`Removing cron job ${job.id} because nextRunAt is invalid.`);
      return {};
    }

    if (nextRunAt.getTime() > now.getTime()) {
      return { nextJob: job };
    }

    let rescheduledAt = nextRunAt.getTime();
    while (rescheduledAt <= now.getTime()) {
      rescheduledAt += job.everySeconds * 1000;
    }

    return {
      dispatch: buildDispatch(job),
      nextJob: {
        ...job,
        nextRunAt: new Date(rescheduledAt).toISOString()
      }
    };
  }

  try {
    if (!matchesCronExpression(job.cronExpr, job.tz, now)) {
      return { nextJob: job };
    }
  } catch (error) {
    logger.warn(`Removing cron job ${job.id}: ${error instanceof Error ? error.message : error}`);
    return {};
  }

  const currentMinuteKey = toMinuteKey(now);
  if (job.lastTriggeredAt === currentMinuteKey) {
    return { nextJob: job };
  }

  return {
    dispatch: buildDispatch(job),
    nextJob: {
      ...job,
      lastTriggeredAt: currentMinuteKey
    }
  };
}

function buildDispatch(job: StoredCronJob): CronDispatch {
  return {
    jobId: job.id,
    text: [
      "Cron job triggered.",
      "",
      `Job ID: ${job.id}`,
      `Schedule: ${describeSchedule(job)}`,
      "",
      "Instruction:",
      job.message
    ].join("\n")
  };
}

function describeJob(job: StoredCronJob) {
  return {
    id: job.id,
    message: job.message,
    schedule: describeSchedule(job),
    created_at: job.createdAt,
    next_run_at: getNextRunAt(job)
  };
}

function describeSchedule(job: StoredCronJob): string {
  switch (job.type) {
    case "every_seconds":
      return `every ${job.everySeconds} seconds`;
    case "cron":
      return `${job.cronExpr} (${job.tz})`;
    case "at":
      return `once at ${job.at}`;
  }
}

function getNextRunAt(job: StoredCronJob): string | null {
  switch (job.type) {
    case "every_seconds":
      return job.nextRunAt;
    case "cron":
      return null;
    case "at":
      return job.at;
  }
}

type CompiledCronExpression = {
  minute: CompiledCronField;
  hour: CompiledCronField;
  dayOfMonth: CompiledCronField;
  month: CompiledCronField;
  dayOfWeek: CompiledCronField;
};

type CompiledCronField = {
  isWildcard: boolean;
  matches(value: number): boolean;
};

function compileCronExpression(expression: string): CompiledCronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression '${expression}'. Expected 5 fields.`);
  }

  return {
    minute: compileCronField(fields[0]!, { label: "minute", min: 0, max: 59 }),
    hour: compileCronField(fields[1]!, { label: "hour", min: 0, max: 23 }),
    dayOfMonth: compileCronField(fields[2]!, { label: "day-of-month", min: 1, max: 31 }),
    month: compileCronField(fields[3]!, { label: "month", min: 1, max: 12 }),
    dayOfWeek: compileCronField(fields[4]!, { label: "day-of-week", min: 0, max: 7, normalize: (value) => value === 7 ? 0 : value })
  };
}

function compileCronField(
  source: string,
  options: {
    label: string;
    min: number;
    max: number;
    normalize?: (value: number) => number;
  }
): CompiledCronField {
  if (source === "*") {
    return {
      isWildcard: true,
      matches: () => true
    };
  }

  const allowed = new Set<number>();
  for (const segment of source.split(",")) {
    const trimmedSegment = segment.trim();
    if (trimmedSegment === "") {
      throw new Error(`Invalid ${options.label} field '${source}'.`);
    }

    const [rangePart, stepPart] = trimmedSegment.split("/");
    const step = stepPart === undefined ? 1 : parseCronInteger(stepPart, `${options.label} step`);
    if (step <= 0) {
      throw new Error(`${options.label} step must be greater than 0.`);
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = options.min;
      end = options.max;
    } else if (rangePart.includes("-")) {
      const [startRaw, endRaw] = rangePart.split("-");
      start = parseCronInteger(startRaw!, `${options.label} range start`);
      end = parseCronInteger(endRaw!, `${options.label} range end`);
      if (end < start) {
        throw new Error(`${options.label} range end must be >= start.`);
      }
    } else {
      start = parseCronInteger(rangePart, options.label);
      end = start;
    }

    for (let value = start; value <= end; value += step) {
      const normalizedValue = options.normalize ? options.normalize(value) : value;
      if (normalizedValue < options.min || normalizedValue > options.max) {
        throw new Error(`${options.label} value '${value}' is out of range.`);
      }
      allowed.add(normalizedValue);
    }
  }

  return {
    isWildcard: false,
    matches: (value: number) => allowed.has(value)
  };
}

function parseCronInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid ${label} '${value}'.`);
  }

  return Number(value);
}

function matchesCronExpression(expression: string, timeZone: string, now: Date): boolean {
  const compiled = compileCronExpression(expression);
  assertValidTimeZone(timeZone);
  const parts = getTimeZoneParts(now, timeZone);
  const month = parts.month;
  const dayOfMonth = parts.day;
  const dayOfWeek = parts.dayOfWeek;

  if (!compiled.minute.matches(parts.minute) || !compiled.hour.matches(parts.hour)) {
    return false;
  }

  if (!compiled.month.matches(month)) {
    return false;
  }

  const dayOfMonthMatches = compiled.dayOfMonth.matches(dayOfMonth);
  const dayOfWeekMatches = compiled.dayOfWeek.matches(dayOfWeek);
  if (compiled.dayOfMonth.isWildcard && compiled.dayOfWeek.isWildcard) {
    return true;
  }

  if (compiled.dayOfMonth.isWildcard) {
    return dayOfWeekMatches;
  }

  if (compiled.dayOfWeek.isWildcard) {
    return dayOfMonthMatches;
  }

  return dayOfMonthMatches || dayOfWeekMatches;
}

function getTimeZoneParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short"
  });
  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  const weekday = lookup.get("weekday");
  const dayOfWeek = parseWeekday(weekday);

  return {
    month: Number(lookup.get("month")),
    day: Number(lookup.get("day")),
    hour: Number(lookup.get("hour")),
    minute: Number(lookup.get("minute")),
    dayOfWeek
  };
}

function parseWeekday(value: string | undefined): number {
  switch (value) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      throw new Error(`Unsupported weekday '${value ?? ""}'.`);
  }
}

function assertValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone '${value}'.`);
  }
}

export function parseAtDateTime(value: string, timeZone?: string): Date {
  if (!timeZone || hasExplicitTimeZone(value)) {
    return parseIsoDateTime(value);
  }

  assertValidTimeZone(timeZone);
  const localDateTime = parseLocalIsoDateTime(value);
  return resolveLocalDateTimeInTimeZone(localDateTime, timeZone);
}

function parseIsoDateTime(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO datetime '${value}'.`);
  }

  return parsed;
}

function toMinuteKey(date: Date): string {
  const minuteDate = new Date(date);
  minuteDate.setUTCSeconds(0, 0);
  return minuteDate.toISOString();
}

function getDelayUntilNextMinute(): number {
  const now = new Date();
  const nextMinute = new Date(now);
  nextMinute.setSeconds(0, 0);
  nextMinute.setMinutes(nextMinute.getMinutes() + 1);
  return Math.max(nextMinute.getTime() - now.getTime(), 1_000);
}

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

function hasExplicitTimeZone(value: string): boolean {
  return /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(value);
}

function parseLocalIsoDateTime(value: string): LocalDateTimeParts {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
  );

  if (!match) {
    throw new Error(`Invalid local ISO datetime '${value}'. Use YYYY-MM-DDTHH:mm[:ss[.SSS]] when providing tz.`);
  }

  const parts: LocalDateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
    millisecond: match[7] ? Number(match[7].padEnd(3, "0")) : 0
  };

  const normalized = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond
  ));

  if (
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() + 1 !== parts.month ||
    normalized.getUTCDate() !== parts.day ||
    normalized.getUTCHours() !== parts.hour ||
    normalized.getUTCMinutes() !== parts.minute ||
    normalized.getUTCSeconds() !== parts.second ||
    normalized.getUTCMilliseconds() !== parts.millisecond
  ) {
    throw new Error(`Invalid local ISO datetime '${value}'.`);
  }

  return parts;
}

function resolveLocalDateTimeInTimeZone(localDateTime: LocalDateTimeParts, timeZone: string): Date {
  let guessMs = Date.UTC(
    localDateTime.year,
    localDateTime.month - 1,
    localDateTime.day,
    localDateTime.hour,
    localDateTime.minute,
    localDateTime.second,
    localDateTime.millisecond
  );

  const targetUtcMs = guessMs;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const actual = getDetailedTimeZoneParts(new Date(guessMs), timeZone);
    const actualUtcMs = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      actual.millisecond
    );
    const diffMs = targetUtcMs - actualUtcMs;
    if (diffMs === 0) {
      const resolved = new Date(guessMs);
      const resolvedParts = getDetailedTimeZoneParts(resolved, timeZone);
      if (matchesLocalDateTime(resolvedParts, localDateTime)) {
        return resolved;
      }
      break;
    }
    guessMs += diffMs;
  }

  throw new Error(`Local datetime '${formatLocalDateTime(localDateTime)}' does not map cleanly in timezone '${timeZone}'.`);
}

function getDetailedTimeZoneParts(date: Date, timeZone: string): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(lookup.get("year")),
    month: Number(lookup.get("month")),
    day: Number(lookup.get("day")),
    hour: Number(lookup.get("hour")),
    minute: Number(lookup.get("minute")),
    second: Number(lookup.get("second")),
    millisecond: Number(lookup.get("fractionalSecond") ?? "0")
  };
}

function matchesLocalDateTime(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second
    && left.millisecond === right.millisecond;
}

function formatLocalDateTime(value: LocalDateTimeParts): string {
  const year = String(value.year).padStart(4, "0");
  const month = String(value.month).padStart(2, "0");
  const day = String(value.day).padStart(2, "0");
  const hour = String(value.hour).padStart(2, "0");
  const minute = String(value.minute).padStart(2, "0");
  const second = String(value.second).padStart(2, "0");
  const millisecond = String(value.millisecond).padStart(3, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}`;
}
