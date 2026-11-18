const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown, max = 200): string | undefined =>
  typeof value === 'string' && value ? value.slice(0, max) : undefined;

export interface ListSummary {
  id: string;
  name: string;
  activeItems?: number;
}

export interface ListItem {
  id: string;
  text: string;
  completed: boolean;
  note?: string;
}

export interface ReminderSummary {
  id: string;
  type: string;
  label?: string;
  status?: string;
  when?: string;
}

// Upstream shapes are not guaranteed, so every field is read defensively and anything unexpected is dropped.
export function summarizeLists(body: unknown): ListSummary[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = text(raw.listId, 256) ?? text(raw.id, 256);
    if (!id) return [];
    let count: number | undefined;
    try {
      const parsed: unknown = typeof raw.totalActiveItemsCount === 'string' ? JSON.parse(raw.totalActiveItemsCount) : raw.totalActiveItemsCount;
      const value = isRecord(parsed) ? parsed.count : parsed;
      if (typeof value === 'number') count = value;
    } catch { /* count is optional */ }
    return [{ id, name: text(raw.listName) ?? text(raw.name) ?? text(raw.listType) ?? 'list', ...(count === undefined ? {} : { activeItems: count }) }];
  });
}

export function summarizeListItems(body: unknown, limit = 100): ListItem[] {
  if (!Array.isArray(body)) return [];
  return body.slice(0, limit).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = text(raw.itemId, 256) ?? text(raw.id, 256);
    const value = text(raw.itemName) ?? text(raw.value);
    if (!id || !value) return [];
    const note = text(raw.note);
    return [{ id, text: value, completed: raw.itemStatus === 'COMPLETE' || raw.completed === true, ...(note ? { note } : {}) }];
  });
}

export function summarizeReminders(body: unknown, limit = 50): ReminderSummary[] {
  const items = isRecord(body) && Array.isArray(body.notifications) ? body.notifications : Array.isArray(body) ? body : [];
  return items.slice(0, limit).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = text(raw.id, 256);
    const type = text(raw.type, 32);
    if (!id || !type) return [];
    const label = text(raw.reminderLabel) ?? text(raw.label);
    const status = text(raw.status, 32);
    const date = text(raw.originalDate, 32);
    const time = text(raw.originalTime, 32);
    const when = date && time ? `${date}T${time}` : typeof raw.alarmTime === 'number' ? new Date(raw.alarmTime).toISOString() : undefined;
    return [{ id, type, ...(label ? { label } : {}), ...(status ? { status } : {}), ...(when ? { when } : {}) }];
  });
}
