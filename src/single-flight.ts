/**
 * 同一时刻只跑一次，后来者**等同一个结果**。
 *
 * 用的地方是 dsh 的握手：`spawn + initialize` 要 ~2 s，这期间又进来一轮对话时，
 * 必须等这次握手，而不是再起一个进程（更不能再把刚起的那个停掉 —— 那会把在途
 * 握手一起杀掉，现象是那一轮直接报 `sdk 进程退出（code=0）`）。
 *
 * 失败不会粘住：`finally` 里清空，下次调用重新尝试。
 */
export class SingleFlight<T> {
  private inFlight: Promise<T> | null = null;

  run(factory: () => Promise<T>): Promise<T> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    // 用 `then` 把 factory 推到微任务里：这样 `inFlight` 一定先赋值，
    // factory 内部再调 `run` 也不会重复启动。
    const attempt = Promise.resolve()
      .then(factory)
      .finally(() => {
        if (this.inFlight === attempt) {
          this.inFlight = null;
        }
      });
    this.inFlight = attempt;
    return attempt;
  }

  /** 有在途的那一次（调试/测试用） */
  get busy(): boolean {
    return this.inFlight !== null;
  }
}
