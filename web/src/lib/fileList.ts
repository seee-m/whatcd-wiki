// Parses the raw Gazelle FileList format seen in torrents.FileList:
//   ".mp3 s6624658s 01 - Hangman.mp3 ÷\n.txt s911s info.txt ÷"
// -- one entry per line, "<ext> s<sizeInBytes>s <filename> ÷".
export interface FileEntry {
  name: string;
  size: number;
}

export function parseFileList(raw: string): FileEntry[] {
  if (!raw) return [];
  return raw
    .split('÷')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^\.\S*\s+s(\d+)s\s+(.+)$/);
      if (!m) return { name: entry, size: 0 };
      return { name: m[2], size: Number(m[1]) };
    });
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 2)} ${units[i]}`;
}
