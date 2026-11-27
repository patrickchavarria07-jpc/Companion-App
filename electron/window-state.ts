import { readFile, rename, writeFile } from 'node:fs/promises';
import { isRecord } from './validation';

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Area = Point & Size;

/** Moves a window of `size` at `point` the minimum distance needed to fit fully inside `area`. */
export function clampToArea(point: Point, size: Size, area: Area): Point {
  return {
    x: Math.max(area.x, Math.min(point.x, area.x + area.width - size.width)),
    y: Math.max(area.y, Math.min(point.y, area.y + area.height - size.height)),
  };
}

/** Persists the widget position between launches. Writes are serialized and failures are ignored. */
export function createPositionStore(file: string) {
  let queue: Promise<void> = Promise.resolve();
  return {
    async load(): Promise<Point | undefined> {
      try {
        const value: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y)) {
          return { x: Math.round(value.x as number), y: Math.round(value.y as number) };
        }
      } catch {
        // Missing or unreadable: fall back to the default position.
      }
      return undefined;
    },
    save(point: Point): Promise<void> {
      queue = queue.then(async () => {
        const temp = file + '.tmp';
        await writeFile(temp, JSON.stringify({ x: Math.round(point.x), y: Math.round(point.y) }));
        await rename(temp, file);
      }).catch(() => {});
      return queue;
    },
  };
}
