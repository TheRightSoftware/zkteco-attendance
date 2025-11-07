export const parseTime = (timeStr: string): number => {
  if (!timeStr || typeof timeStr !== "string") return 0;

  const trimmed = timeStr.trim();
  if (!trimmed) return 0;

  const [timePart, meridiemRaw] = trimmed.split(/\s+/);
  if (!timePart) return 0;

  const [hourStr, minuteStr] = timePart.split(":");
  if (hourStr === undefined || minuteStr === undefined) return 0;

  let hours = Number(hourStr);
  const minutes = Number(minuteStr);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;

  if (meridiemRaw) {
    const meridiem = meridiemRaw.replace(/[^a-zA-Z]/g, "").toLowerCase();
    if (meridiem === "pm" && hours < 12) {
      hours += 12;
    } else if (meridiem === "am" && hours === 12) {
      hours = 0;
    }
  }

  return hours * 60 + minutes;
};

