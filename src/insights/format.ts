// Numbers and sizes as Insights writes them, in the UI language. Shared by the host and the webview.
import { language } from "../i18n";

export const formatNumber = (n: number): string => new Intl.NumberFormat(language()).format(n);

/** 1536 → "1.5 KB": a size as the Explorer's hover says it. */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${new Intl.NumberFormat(language(), { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v)} ${units[i]}`;
}
