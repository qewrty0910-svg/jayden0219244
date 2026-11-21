import { WORLD_HALF, type TreeRecord } from './types';

export class TreeSpatialGrid3D {
  private readonly cellSize: number;
  private readonly span: number;
  private readonly cols: number;
  private readonly buckets: TreeRecord[][];

  constructor(cellSize = 12) {
    this.cellSize = cellSize;
    this.span = WORLD_HALF * 2 + 20;
    this.cols = Math.ceil(this.span / cellSize);
    this.buckets = new Array(this.cols * this.cols);
    for (let i = 0; i < this.buckets.length; i++) {
      this.buckets[i] = [];
    }
  }

  clear(): void {
    for (let i = 0; i < this.buckets.length; i++) {
      this.buckets[i].length = 0;
    }
  }

  private toIndex(v: number): number {
    const idx = Math.floor((v + WORLD_HALF + 10) / this.cellSize);
    if (idx < 0) return 0;
    if (idx >= this.cols) return this.cols - 1;
    return idx;
  }

  insert(tree: TreeRecord): void {
    const cx = this.toIndex(tree.x);
    const cz = this.toIndex(tree.z);
    this.buckets[cz * this.cols + cx].push(tree);
  }

  queryRect(minX: number, minZ: number, maxX: number, maxZ: number, out: TreeRecord[]): TreeRecord[] {
    out.length = 0;
    const c0 = this.toIndex(minX);
    const c1 = this.toIndex(maxX);
    const r0 = this.toIndex(minZ);
    const r1 = this.toIndex(maxZ);

    for (let r = r0; r <= r1; r++) {
      const rowOffset = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        const bucket = this.buckets[rowOffset + c];
        for (let i = 0; i < bucket.length; i++) {
          out.push(bucket[i]);
        }
      }
    }
    return out;
  }
}
