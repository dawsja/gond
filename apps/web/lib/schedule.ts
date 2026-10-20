const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number): string {
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function list(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** A cron field of plain numbers, ranges and lists ("1-5", "9,17"), expanded and sorted; null for anything else. */
function numbers(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from < min || to > max || from > to) return null;
    for (let n = from; n <= to; n += 1) out.add(max === 7 && n === 7 ? 0 : n);
  }
  return [...out].sort((a, b) => a - b);
}

function days(field: string): string | null {
  if (field === "*") return "Every day";
  const picked = numbers(field, 0, 7);
  if (!picked) return null;
  const key = picked.join(",");
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  if (key === "0,1,2,3,4,5,6") return "Every day";
  return picked.length === 1 ? `Every ${DAYS[picked[0]!]}` : `${list(picked.map((d) => `${DAYS[d]}s`))}`;
}

/** A routine's five-field cron as words a person reads; never the cron itself. */
export function describeSchedule(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "On a custom schedule";
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (month !== "*") return "On a custom schedule";

  const every = /^\*\/(\d+)$/.exec(min);
  if (every && hour === "*" && dom === "*" && dow === "*") return Number(every[1]) === 1 ? "Every minute" : `Every ${Number(every[1])} minutes`;
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && dow === "*") return Number(min) === 0 ? "Every hour" : `Every hour at ${Number(min)} past`;
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(min) && everyHours && dom === "*" && dow === "*") return `Every ${Number(everyHours[1])} hours`;

  const minute = /^\d+$/.test(min) ? Number(min) : null;
  const hours = numbers(hour, 0, 23);
  if (minute === null || minute > 59 || !hours) return "On a custom schedule";
  const at = `at ${list(hours.map((h) => clock(h, minute)))}`;

  if (dom === "*") {
    const on = days(dow);
    return on ? `${on} ${at}` : "On a custom schedule";
  }
  const dates = numbers(dom, 1, 31);
  if (dates && dow === "*") return `Monthly on the ${list(dates.map(ordinal))} ${at}`;
  return "On a custom schedule";
}
