import type { Tone } from "@/types";

export interface Cell {
  kind: "text" | "badge" | "person";
  v: string;
  sub?: string;
  fw?: number;
  fg?: string;
  mono?: boolean;
  align?: "start" | "end";
  tone?: Tone;
  ini?: string;
}

export const text = (v: string | number, sub?: string, o: Partial<Cell> = {}): Cell => ({ kind: "text", v: String(v), sub, ...o });
export const num = (v: string | number, o: Partial<Cell> = {}): Cell => text(v, undefined, { align: "end", fw: 600, ...o });
export const mono = (v: string, sub?: string): Cell => text(v, sub, { mono: true, fw: 600 });
export const badge = (v: string, tone?: Tone): Cell => ({ kind: "badge", v, tone });
export const person = (v: string, ini: string, sub?: string): Cell => ({ kind: "person", v, ini, sub, fw: 600 });

export interface Column {
  label: string;
  w: number;
  align?: "end";
}

export interface TableRow {
  key: string | number;
  cells: Cell[];
}

/** What the table needs to draw a filter dropdown: the first option means "no filter". */
export interface FilterShape {
  key: string;
  label: string;
  options: string[];
}
