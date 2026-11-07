import { Cron } from 'croner';
import { MonitorError } from './types.js';

const YEAR = 366 * 86_400_000;
export const minuteStart = (date: Date) => new Date(Math.floor(date.getTime() / 60_000) * 60_000);

/** Deliberately bounded subset: five numeric fields, UTC, at most once a minute. */
export function cronSchedule(expression: string, timezone: string, now: Date): Cron {
  if (timezone !== 'UTC') throw new MonitorError('INVALID_SCHEDULE', '当前仅支持 UTC 时区');
  const fields = expression.trim().split(/\s+/);
  if (expression.length > 120 || fields.length !== 5 || fields.some((field) => !/^[\d*,/\-]+$/.test(field))) {
    throw new MonitorError('INVALID_SCHEDULE', '请输入五字段 cron：分 时 日 月 星期；仅支持数字、*、逗号、范围和步长，时区为 UTC');
  }
  try {
    const schedule = new Cron(fields.join(' '), { timezone: 'UTC', paused: true });
    const next = schedule.nextRun(now);
    if (!next || next.getTime() > now.getTime() + YEAR) { schedule.stop(); throw new Error('out of range'); }
    return schedule;
  } catch {
    throw new MonitorError('INVALID_SCHEDULE', 'cron 无效，或未来 366 天内没有执行时间');
  }
}

export function nextRun(expression: string, now: Date): string {
  const schedule = cronSchedule(expression, 'UTC', now);
  try { return schedule.nextRun(now)!.toISOString(); } finally { schedule.stop(); }
}

export function skipMissed(expression: string, previous: string, now: Date): { missed: number; capped: boolean; next: string } {
  const schedule = cronSchedule(expression, 'UTC', now);
  const current = minuteStart(now).getTime();
  let cursor = new Date(previous); let missed = 0;
  try {
    while (cursor.getTime() < current && missed < 10_000) {
      missed++;
      const following = schedule.nextRun(cursor);
      if (!following) break;
      cursor = following;
    }
    const capped = missed === 10_000 && cursor.getTime() < current;
    if (capped) cursor = schedule.nextRun(new Date(current - 1))!;
    return { missed, capped, next: cursor.toISOString() };
  } finally { schedule.stop(); }
}
