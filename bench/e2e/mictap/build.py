#!/usr/bin/env python3
"""把 tmp/mictap 打成可安装的 MicTap APK（不需要 Gradle）。

    python tmp/mictap/build.py            # 编译 + 打包 + 签名
    python tmp/mictap/build.py --install  # 另外安装 + pm grant RECORD_AUDIO

只做一件事：让手机麦克风能录出一段 PCM。app_process 那条路被 audioserver
按 AttributionSource 静音了（setRecordSilenced uid:0），必须有真包身份。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = HERE / "out"

SDK_CANDIDATES = [
    os.environ.get("ANDROID_HOME", ""),
    os.environ.get("ANDROID_SDK_ROOT", ""),
    r"C:\Android\Sdk",
    str(Path.home() / "Android" / "Sdk"),
]

PACKAGE = "com.miaiglasses.mictap"


def find_sdk() -> Path:
    for c in SDK_CANDIDATES:
        if c and Path(c).is_dir():
            return Path(c)
    raise SystemExit("找不到 Android SDK（设 ANDROID_HOME）")


def newest(sdk: Path, sub: str) -> Path:
    base = sdk / sub
    if not base.is_dir():
        raise SystemExit(f"{base} 不存在")

    def key(p: Path) -> tuple:
        try:
            return tuple(int(x) for x in p.name.replace("android-", "").split("."))
        except ValueError:
            return (0,)

    return sorted((d for d in base.iterdir() if d.is_dir()), key=key, reverse=True)[0]


def tool(bt: Path, *names: str) -> Path:
    for n in names:
        p = bt / n
        if p.exists():
            return p
    raise SystemExit(f"{bt} 下找不到 {names}")


def run(argv: list, quiet: bool = False) -> None:
    r = subprocess.run([str(a) for a in argv], capture_output=True, text=True)
    if r.returncode != 0:
        print("  $ " + " ".join(str(a) for a in argv))
        print(((r.stdout or "") + (r.stderr or "")).strip()[-3000:])
        raise SystemExit(f"失败：{Path(str(argv[0])).name}")
    if not quiet:
        text = ((r.stdout or "") + (r.stderr or "")).strip()
        if text:
            print("  " + text.replace("\n", "\n  "))


def serial() -> str:
    r = subprocess.run(["adb", "devices"], capture_output=True, text=True)
    for line in (r.stdout or "").splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            return parts[0]
    raise SystemExit("adb devices 里没有 device 状态的行")


def main() -> int:
    sdk = find_sdk()
    android_jar = newest(sdk, "platforms") / "android.jar"
    bt = newest(sdk, "build-tools")
    aapt2, d8 = tool(bt, "aapt2.exe", "aapt2"), tool(bt, "d8.bat", "d8")
    zipalign = tool(bt, "zipalign.exe", "zipalign")
    apksigner = tool(bt, "apksigner.bat", "apksigner")

    shutil.rmtree(OUT, ignore_errors=True)
    for d in ("classes", "dex"):
        (OUT / d).mkdir(parents=True, exist_ok=True)

    print(f"[mictap] android = {android_jar.parent.name}/{android_jar.name}")
    print(f"[mictap] build-tools = {bt.name}")

    # 1) manifest + 资源 → 未签 APK（aapt2 link 会把它转成二进制 XML）
    base = OUT / "base.apk"
    run([
        aapt2, "link", "-o", base, "-I", android_jar,
        "--manifest", HERE / "AndroidManifest.xml",
        "--min-sdk-version", "26", "--target-sdk-version", "34",
    ], quiet=True)

    # 2) java → class（-source/-target 8：d8 认的 class 版本，且不依赖 JDK 模块）
    sources = [str(p) for p in (HERE / "src").rglob("*.java")]
    run([
        "javac", "-encoding", "UTF-8", "-source", "8", "-target", "8",
        "-nowarn", "-cp", android_jar, "-d", OUT / "classes", *sources,
    ], quiet=True)

    # 3) class → dex
    classes = [str(p) for p in (OUT / "classes").rglob("*.class")]
    run([
        d8, "--min-api", "26", "--lib", android_jar, "--output", OUT / "dex", *classes,
    ], quiet=True)

    # 4) 把 classes.dex 塞进 APK（aapt2 link 的产物里只有 manifest/resources）
    import zipfile

    with zipfile.ZipFile(base, "a") as z:
        z.write(OUT / "dex" / "classes.dex", "classes.dex")

    # 5) 对齐 + 签名（debug keystore：adb 安装不校验它的来源，只要签过）
    aligned = OUT / "aligned.apk"
    run([zipalign, "-f", "4", base, aligned], quiet=True)
    ks = Path.home() / ".android" / "debug.keystore"
    if not ks.exists():
        raise SystemExit(f"没有 {ks}（Android Studio 会自动生成）")
    signed = OUT / "mictap.apk"
    run([
        apksigner, "sign",
        "--ks", ks, "--ks-pass", "pass:android", "--key-pass", "pass:android",
        "--out", signed, aligned,
    ], quiet=True)
    print(f"[mictap] ✓ {signed.name}  {signed.stat().st_size} 字节  ({len(classes)} 个 class)")

    if "--install" in sys.argv:
        s = serial()
        run(["adb", "-s", s, "install", "-r", "-g", signed])
        run(["adb", "-s", s, "shell", "pm", "grant", PACKAGE, "android.permission.RECORD_AUDIO"])
        print(f"[mictap] ✓ 已装到 {s} 并授予 RECORD_AUDIO")
    return 0


if __name__ == "__main__":
    sys.exit(main())
