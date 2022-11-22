function min(a: number, b: number): number {
  return a > b ? b : a;
}
function max(a: number, b: number): number {
  return a < b ? b : a;
}

export class DurationCounter {
  min: number = 0;
  max: number = 0;
  sum: number = 0;
  count: number = 0;

  curStart: number = -1;

  addDuration(duration: number) {
    if (this.count === 0) {
      this.min = duration;
      this.max = duration;
    }

    this.count++;
    this.sum += duration;

    this.min = min(duration, this.min);
    this.max = max(duration, this.max);
  }

  start() {
    if (this.curStart !== -1) {
      throw new Error(
        "Implementation error: DurationCounter.start() without stop() first"
      );
    }
    this.curStart = new Date().getTime();
  }
  stop() {
    if (this.curStart === -1) {
      throw new Error(
        "Implementation error: DurationCounter.stop() without start() first"
      );
    }
    const stop = new Date().getTime();
    this.addDuration(stop - this.curStart);
    this.curStart = -1;
  }

  avg(): number {
    return this.sum / this.count;
  }
}
