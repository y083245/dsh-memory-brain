"""把 pytest 的 JUnit XML 失败用例输出成 GitHub Actions ::error:: 注解。

为什么需要：公开仓库的 Actions 原始日志需要仓库管理员权限才能通过 API 下载；
fork/外部贡献者排查 CI 时只能看到「Process completed with exit code 1」。
JUnit XML 由 pytest 生成，这里只读它并把失败用例名 + 断言消息写成 annotation。
"""

import sys
import xml.etree.ElementTree as ET


def escape(value: str) -> str:
    return (value or "").replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def main(path: str) -> int:
    try:
        root = ET.parse(path).getroot()
    except Exception as error:  # noqa: BLE001 - 诊断脚本不能把 CI 弄得更糟
        print(f"::warning title=pytest-summary::cannot parse {path}: {error}")
        return 0
    found = 0
    for case in root.iter("testcase"):
        failures = [*case.findall("failure"), *case.findall("error")]
        for failure in failures:
            found += 1
            name = f"{case.get('classname') or '?'}::{case.get('name') or '?'}"
            message = (failure.get("message") or failure.text or "").strip()
            print(f"::error title={escape(name)[:240]}::{escape(message)[:4000]}")
    if not found:
        print("::warning title=pytest-summary::JUnit XML has no failure/error entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else "pytest.xml"))
