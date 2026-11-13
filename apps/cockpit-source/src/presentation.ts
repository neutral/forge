// What the cockpit draws for each state: a mark and a word, and whether the Director
// must attend to it (handbook/practices/sheet.md). The mark says which kind of state;
// the word beside it says which state, so no legend is needed.

import type { Detail, StoredFile } from './cockpit.ts';

export const marks = { active: '●', between: '◐', rest: '○', attend: '△' } as const;
export interface State { mark: string; word: string; attend: boolean }
const state = (mark: string, word: string, attend = false): State => ({ mark, word, attend });

/** The selected Direction's Worker: whether one is selected, as the Directions list says it. */
export function workerState(detail: Detail): State {
  return detail.workerId ? state(marks.active, 'Worker selected') : state(marks.rest, 'No Worker selected');
}

export function decodeFile(file: StoredFile): { text?: string; binary?: boolean } {
  if (file.encoding !== 'base64') return { text: String(file.content ?? '') };
  try {
    const bytes = Uint8Array.from(atob(file.content || ''), char => char.charCodeAt(0));
    if (bytes.includes(0)) return { binary: true };
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch { return { binary: true }; }
}

export type PatchLine = 'file' | 'added' | 'removed' | 'hunk' | 'context';
export function patchLine(line: string): PatchLine {
  if (line.startsWith('diff --git') || line.startsWith('+++') || line.startsWith('---')) return 'file';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  if (line.startsWith('@@')) return 'hunk';
  return 'context';
}

/** A stored time in the Director's locale; drawn only after the page has hydrated. */
export function time(value?: string | null) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function clock(date: Date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
