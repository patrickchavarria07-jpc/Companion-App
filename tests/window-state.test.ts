import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clampToArea, createPositionStore } from '../electron/window-state';

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { width: 104, height: 104 };

describe('clampToArea', () => {
  it('keeps positions that already fit', () => {
    expect(clampToArea({ x: 500, y: 300 }, size, area)).toEqual({ x: 500, y: 300 });
  });

  it('pulls off-screen positions back inside the work area', () => {
    expect(clampToArea({ x: 5000, y: -20 }, size, area)).toEqual({ x: 1816, y: 0 });
    expect(clampToArea({ x: -300, y: 2000 }, size, { x: -1280, y: 0, width: 1280, height: 1000 })).toEqual({ x: -300, y: 896 });
  });
});

describe('createPositionStore', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'buddy-window-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('round-trips the last saved position', async () => {
    const file = join(dir, 'window-state.json');
    const store = createPositionStore(file);
    expect(await store.load()).toBeUndefined();
    void store.save({ x: 10.4, y: 20 });
    await store.save({ x: 300, y: 400.6 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ x: 300, y: 401 });
    expect(await createPositionStore(file).load()).toEqual({ x: 300, y: 401 });
  });

  it('ignores invalid files and swallows write errors', async () => {
    const file = join(dir, 'window-state.json');
    await writeFile(file, '{"x":"left","y":1}');
    expect(await createPositionStore(file).load()).toBeUndefined();
    await writeFile(file, 'garbage');
    expect(await createPositionStore(file).load()).toBeUndefined();
    await expect(createPositionStore(join(dir, 'missing', 'state.json')).save({ x: 1, y: 2 })).resolves.toBeUndefined();
  });
});
