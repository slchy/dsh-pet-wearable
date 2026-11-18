#!/usr/bin/env python3
"""把 Smart Turn 官方训练集重采样成「中文为主 + 其它语言锚点」的本地数据集。

上游（BSD-2 代码 + CC-BY-4.0 数据）：
https://github.com/pipecat-ai/smart-turn
https://huggingface.co/datasets/pipecat-ai/smart-turn-data-v3.2-train

v3.2 训练集共 270,946 条 / 41.4 GB，中文只占约 2.7%（抽样 38.6k 条里 zho 1057）。
这个脚本把 zho 全留下并重复若干倍，其它 22 种语言各抽一个固定上限当锚点，
防止只喂中文之后把多语言能力洗掉。

用法（在装了 requirements 的机器上）：

    python prep_zh_mix.py --out /data/zh-mix

    # 中文重复 5 倍、其它语言各 1500 条
    python prep_zh_mix.py --zh-repeat 5 --other-per-lang 1500 --out /data/zh-mix

产出的目录是一个 DatasetDict(train=...)，直接把上游 `train.py` 的
`CONFIG["datasets_training"]` 指成 `["/data/zh-mix"]`（**以 / 开头 = 走 load_from_disk**）。
它会再切 10% 出来当 eval。

注意磁盘：原始 41.4 GB（HF 缓存里还留一份），重采样后另存一份，`save_to_disk`
会复制音频字节 —— 按 zh 重复倍数算，预留 **120 GB 以上**比较稳。
标注字段（`endpoint_bool` / `language` / `midfiller` …）原样保留。
"""
from __future__ import annotations

import argparse
from collections import Counter

from datasets import DatasetDict, concatenate_datasets, load_dataset

TRAIN_REPO = "pipecat-ai/smart-turn-data-v3.2-train"
ZH = "zho"


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--repo", default=TRAIN_REPO, help="HF 数据集 id")
    ap.add_argument("--zh-repeat", type=int, default=3, help="中文样本重复倍数（默认 3）")
    ap.add_argument(
        "--other-per-lang", type=int, default=1500, help="每种非中文语言最多取几条（0 = 全丢）"
    )
    ap.add_argument("--out", required=True, help="输出目录（写成 DatasetDict）")
    args = ap.parse_args()

    ds = load_dataset(args.repo, split="train")
    print(f"原始：{len(ds)} 条")

    # 只读 language 一列，不解码音频
    langs = ds["language"]
    counts = Counter(langs)
    print("语言分布（原始）：")
    for lang, n in counts.most_common():
        print(f"  {lang:<5} {n:>7}")

    by_lang: dict[str, list[int]] = {}
    for idx, lang in enumerate(langs):
        by_lang.setdefault(lang, []).append(idx)

    zh_idx = by_lang.get(ZH, [])
    if not zh_idx:
        raise SystemExit(f"数据集里没有 {ZH}，用 --repo 换一个")

    repeat = max(1, args.zh_repeat)
    parts = [ds.select(zh_idx) for _ in range(repeat)]
    print(f"中文：{len(zh_idx)} 条 × {repeat} = {len(zh_idx) * repeat}")

    if args.other_per_lang > 0:
        for lang, idx in sorted(by_lang.items()):
            if lang == ZH:
                continue
            take = idx[: args.other_per_lang]
            parts.append(ds.select(take))
            print(f"  {lang:<5} 取 {len(take)}/{len(idx)}")

    mixed = concatenate_datasets(parts).shuffle(seed=42)
    pos = sum(1 for v in mixed["endpoint_bool"] if v)
    print(f"\n混合后：{len(mixed)} 条，中文占比 {len(zh_idx) * repeat / len(mixed):.1%}")
    print(f"标签：endpoint=True {pos} / False {len(mixed) - pos}")

    DatasetDict({"train": mixed}).save_to_disk(args.out)
    print(f"已写入 {args.out}")
    print(f'→ 把上游 train.py 的 CONFIG["datasets_training"] 改成 ["{args.out}"]')


if __name__ == "__main__":
    main()
